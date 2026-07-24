import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withReasoning } from "../better-native-pi/core.js";
import { registerOverlayCard } from "../overlay-stack/index.js";
import { TranscriptPager, type TranscriptEntry } from "../transcript/pager.js";
import {
	compactContext,
	createContextFork,
	parentContextMessages,
	type CompactContext,
	type ContextFork,
	type ContextMode,
} from "./context.js";
import {
	RpcProcessClient,
	childEnvironment,
	getPiInvocation,
	isSubagentChild,
	type AgentClientFactory,
	type AgentClientOptions,
} from "./rpc.js";
import { loadSubagentsConfig, type SubagentsRuntimeConfig } from "./config.js";
import {
	agentNameKey,
	boundedInput,
	boundedText,
	compact,
	createAgentLifecycle,
	isActive,
	normalizeAgentName,
	resetCompletion as newCompletion,
	RESULT_BYTES,
	sanitizeTerminal,
	toAgentSnapshot as snapshot,
	type AgentSnapshot,
	type ManagedAgent,
} from "./lifecycle.js";
import { AgentMailbox, type AgentMailboxEvent } from "./mailbox.js";
import { createMailboxPersistence } from "./persistence.js";
import {
	COMPLETION_MESSAGE_TYPE,
	MAILBOX_BATCH_TYPE,
	MAILBOX_HISTORY_ENTRY_TYPE,
	MAILBOX_MESSAGE_TYPE,
	childTaskEntry,
	childTranscriptEntries,
	formatAgent,
	formatAgents,
	formatMailboxEvents,
	mailboxBatchContent,
	mailboxMessageContent,
	mailboxStatus,
	messageContent,
	registerSubagentRenderers,
	renderAgentCall,
	renderAgentResult,
	renderAgentsOverlayBody,
	statusSymbol,
	type ToolDetails,
} from "./rendering.js";
import { SUBAGENT_USAGE_ENTRY_TYPE, SUBAGENT_USAGE_EVENT, persistedSubagentUsage } from "./usage.js";

export { boundedText, type AgentSnapshot, type AgentStatus } from "./lifecycle.js";
export { renderAgentsOverlayBody } from "./rendering.js";

const TOOL_NAME = "agents";
const REPORT_TOOL_NAME = "report_to_parent";
const DEFAULT_MAX_AGENTS = 6;
const MAX_RETAINED_CLOSED = 20;
const DEFAULT_WAIT_RETURN = "any";
const DEFAULT_WAIT_WAKE = "any";
const TOOL_OUTPUT_BYTES = 48 * 1024;
const MAX_TASK_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_QUEUED_CHILD_MESSAGES = 4;
const MAX_REPORT_CHARS = 4_000;
const MAX_AGENT_NAME_CHARS = 80;
const OVERLAY_WIDTH = 58;

const CHILD_PROMPT = `You are a delegated child agent working in an isolated conversation.
Complete only the explicit task below.
Work autonomously with the available tools. Return a concise final result with relevant file paths, commands, findings, or remaining blockers.
Use report_to_parent only for a material interim update that can unblock or redirect the parent. Your final response is reported automatically.
Do not ask the user questions; report any missing information to the parent agent.`;

type WaitReturn = "any" | "all";
type WaitWake = "any" | "final";

export interface SubagentsOptions {
	createClient?: AgentClientFactory;
	createContextFork?: typeof createContextFork;
	compactContext?: CompactContext;
	registerOverlayCard?: typeof registerOverlayCard;
	maxAgents?: number;
	config?: SubagentsRuntimeConfig;
}


function registerChildReporter(pi: ExtensionAPI): void {
	pi.registerTool({
		name: REPORT_TOOL_NAME,
		label: "Report to parent",
		description: "Send one material interim update to the parent agent. Use sparingly for findings that can unblock or redirect parallel work; the final response is delivered automatically.",
		promptSnippet: "Report a material interim update to the parent agent",
		parameters: withReasoning({
			type: "object",
			properties: {
				message: { type: "string", maxLength: MAX_REPORT_CHARS, description: "Concise interim update for the parent" },
			},
			required: ["message"],
		} as any),
		async execute(_toolCallId: string, params: any) {
			const message = boundedInput(params.message, "report message", MAX_REPORT_CHARS);
			return { content: [{ type: "text", text: `Reported to parent: ${message}` }] };
		},
	});
}


function buildArgs(pi: ExtensionAPI, ctx: any, fork: ContextFork): string[] {
	const args = ["--mode", "rpc", "--session", fork.sessionFile, "--session-dir", fork.directory];
	if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	const thinking = pi.getThinkingLevel();
	if (thinking) args.push("--thinking", thinking);
	const tools = [...pi.getActiveTools().filter((name) => name !== TOOL_NAME && name !== REPORT_TOOL_NAME), REPORT_TOOL_NAME];
	args.push("--tools", tools.join(","));
	return args;
}

function childTask(name: string, task: string, contextMode: ContextMode): string {
	const contextNote = contextMode === "fresh"
		? "No parent conversation was inherited; rely on the explicit task and available project instructions."
		: contextMode === "compacted"
			? "A compacted parent-conversation summary was inherited as context, not as a request to continue unrelated work."
			: "The forked parent conversation is context, not a request to continue unrelated work.";
	return `${CHILD_PROMPT}\n${contextNote}\n\nChild agent name: ${name}\n\nTask:\n${task.trim()}`;
}

export default function registerSubagents(pi: ExtensionAPI, options: SubagentsOptions = {}) {
	if (isSubagentChild()) {
		registerChildReporter(pi);
		return;
	}
	const agents = new Map<string, ManagedAgent>();
	const createClient = options.createClient ?? ((clientOptions: AgentClientOptions) => new RpcProcessClient(clientOptions));
	const forkContext = options.createContextFork ?? createContextFork;
	const summarizeContext = options.compactContext ?? compactContext;
	const registerCard = options.registerOverlayCard ?? registerOverlayCard;
	const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
	const runtimeConfig = options.config ?? loadSubagentsConfig();
	let generation = 0;
	let sessionActive = false;
	let parentRunning = false;
	let spawnReservations = 0;
	let compactedSnapshot: { key: string; promise: Promise<string> } | undefined;
	let activeTranscriptRefresh: (() => void) | undefined;
	let activeMailboxAnchor: number | undefined;
	const mailbox = new AgentMailbox<AgentSnapshot>(
		runtimeConfig.mailbox.maxMessageBytes,
		runtimeConfig.mailbox.maxMessagesPerAgent,
	);
	const activeTurnMailbox = new AgentMailbox<AgentSnapshot>(
		runtimeConfig.mailbox.maxMessageBytes,
		runtimeConfig.mailbox.maxMessagesPerAgent,
	);
	const mailboxListeners = new Set<() => void>();
	const usedAgentNames = new Set<string>();
	const reservedAgentNames = new Set<string>();

	const openAgents = () => [...agents.values()].filter((agent) => agent.status !== "closed" && !agent.cleanupComplete);
	const orderedAgents = () => [...agents.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt);
	const activeAgents = () => orderedAgents().filter((agent) => agent.client && isActive(agent));
	const overlayCard = registerCard({
		id: "subagents",
		order: 15,
		width: OVERLAY_WIDTH,
		minBodyHeight: 1,
		minTerminalWidth: 90,
		minTerminalHeight: 10,
		visible: () => activeAgents().length > 0 || mailbox.snapshot().unread > 0,
		title: (theme) => {
			const active = activeAgents().length;
			const unread = mailbox.snapshot().unread;
			return `${theme.bold(" Agents ")}${theme.fg("accent", `● ${active} running${unread > 0 ? ` · ✉ ${unread} unread` : ""}`)} `;
		},
		renderBody: (width, maxHeight, theme) => renderAgentsOverlayBody(activeAgents().map(snapshot), width, maxHeight, theme, mailbox.snapshot()),
	});
	const updateOverlay = () => overlayCard.invalidate();
	const showTranscript = async (agent: ManagedAgent, ctx: any) => {
		if (agent.cleanupComplete) {
			ctx.ui.notify(`Transcript unavailable after ${agent.name} was closed.`, "info");
			return;
		}
		let entries: TranscriptEntry[] = [childTaskEntry(agent)];
		const loadEntries = () => {
			try { entries = childTranscriptEntries(agent); }
			catch { /* Keep the last complete snapshot while the child appends. */ }
			return entries;
		};
		try {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => {
				const pager = new TranscriptPager(
					loadEntries,
					theme,
					() => tui.requestRender(),
					done,
					{ title: `Agent transcript · ${agent.name}`, startAtEnd: true },
				);
				activeTranscriptRefresh = () => {
					pager.invalidate();
					tui.requestRender();
				};
				return pager;
			}, {
				overlay: true,
				overlayOptions: { width: "95%", maxHeight: "92%", anchor: "center", margin: 1 },
			});
		} finally {
			activeTranscriptRefresh = undefined;
		}
	};
	const resolveAgent = (nameOrLegacyId: string): ManagedAgent | undefined => {
		const query = sanitizeTerminal(nameOrLegacyId).replace(/\s+/g, " ").trim();
		if (!query) return undefined;
		const key = agentNameKey(query);
		return [...agents.values()].find((agent) => agent.name && agentNameKey(agent.name) === key)
			?? agents.get(query);
	};
	const queueChildMessage = (agent: ManagedAgent, message: string) => {
		if (agent.queuedMessages.length >= MAX_QUEUED_CHILD_MESSAGES) {
			throw new Error(`Agent ${agent.name} already has ${MAX_QUEUED_CHILD_MESSAGES} queued messages; send a follow-up before queueing more`);
		}
		agent.queuedMessages.push(message);
	};
	const trimClosed = () => {
		const closed = [...agents.values()]
			.filter((agent) => agent.status === "closed" && agent.cleanupComplete)
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		while (closed.length > MAX_RETAINED_CLOSED) {
			const oldest = closed.shift();
			if (oldest) agents.delete(oldest.id);
		}
	};
	const reserveSpawn = (name: string): { generation: number; commit(): void; release(): void } => {
		if (!sessionActive) throw new Error("Cannot spawn a subagent outside an active parent session");
		const key = agentNameKey(name);
		if (usedAgentNames.has(key) || reservedAgentNames.has(key)) throw new Error(`Agent name already exists: ${name}`);
		if (openAgents().length + spawnReservations >= maxAgents) {
			throw new Error(`At most ${maxAgents} subagents may remain open; close one before spawning another`);
		}
		spawnReservations += 1;
		reservedAgentNames.add(key);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			reservedAgentNames.delete(key);
			spawnReservations = Math.max(0, spawnReservations - 1);
		};
		return {
			generation,
			commit() {
				if (released) return;
				usedAgentNames.add(key);
				release();
			},
			release,
		};
	};
	const assertCurrentSession = (expectedGeneration: number) => {
		if (!sessionActive || generation !== expectedGeneration) {
			throw new Error("Parent session ended while spawning subagent");
		}
	};
	const compactedContextFor = (ctx: any, signal?: AbortSignal): Promise<string> => {
		const key = `${generation}:${ctx.sessionManager.getLeafId() ?? "empty"}`;
		if (compactedSnapshot?.key === key) return compactedSnapshot.promise;
		const promise = summarizeContext(ctx, parentContextMessages(ctx), signal).catch((error) => {
			if (compactedSnapshot?.promise === promise) compactedSnapshot = undefined;
			throw error;
		});
		compactedSnapshot = { key, promise };
		return promise;
	};
	const { persistFinal: persistMailboxFinal, restoreFinals: restoreMailboxFinals } = createMailboxPersistence(pi, mailbox);
	const removeMailboxEvent = (event: AgentMailboxEvent<AgentSnapshot>) => {
		mailbox.remove(event.sequence);
		persistMailboxFinal(event, "delivered");
		updateOverlay();
	};
	const deliverMailboxEvent = (event: AgentMailboxEvent<AgentSnapshot>) => {
		if (!mailbox.has((candidate) => candidate.sequence === event.sequence)) return;
		const candidate = agents.get(event.agentId);
		const agent = candidate?.generation === generation ? candidate : undefined;
		if (agent && (agent.suppressNotifications || agent.waiting > 0 || agent.status === "closed")) return;
		if (!agent && !(event.recovered && event.kind === "final" && event.final)) return;
		if (event.kind === "final" && agent && agent.completionDelivery !== "none") {
			removeMailboxEvent(event);
			return;
		}
		if (parentRunning) return;
		try {
			const delivery = { triggerTurn: false };
			if (event.kind === "final") {
				const data = event.final ?? snapshot(agent!);
				pi.sendMessage({
					customType: COMPLETION_MESSAGE_TYPE,
					content: messageContent(data),
					display: true,
					details: data,
				}, delivery);
				if (agent) agent.completionDelivery = "automatic";
				persistMailboxFinal(event, "delivered");
			} else {
				pi.sendMessage({
					customType: MAILBOX_MESSAGE_TYPE,
					content: mailboxMessageContent(event),
					display: true,
					details: event,
				}, delivery);
			}
			mailbox.take((candidate) => candidate.sequence === event.sequence, "delivered");
			updateOverlay();
		} catch {
			// Leave the event queued so a later wait can collect it.
		}
	};
	const publishMailboxEvent = (agent: ManagedAgent, kind: AgentMailboxEvent["kind"], content: string): AgentMailboxEvent<AgentSnapshot> => {
		const event = mailbox.publish({
			kind,
			agentId: agent.id,
			agentName: agent.name ?? "unnamed agent",
			content: boundedText(sanitizeTerminal(content), kind === "message" ? MAX_REPORT_CHARS : RESULT_BYTES),
			createdAt: Date.now(),
			persistenceKey: kind === "final" ? `${agent.id}:${randomBytes(6).toString("hex")}` : undefined,
			status: kind === "final" ? agent.status : undefined,
			final: kind === "final" ? snapshot(agent) : undefined,
		});
		if (kind === "final") persistMailboxFinal(event, "unread");
		for (const listener of [...mailboxListeners]) listener();
		updateOverlay();
		if (agent.waiting === 0) queueMicrotask(() => deliverMailboxEvent(event));
		return event;
	};
	const takeMailboxEvents = (targets: ManagedAgent[]): AgentMailboxEvent<AgentSnapshot>[] => {
		const targetIds = new Set(targets.map((agent) => agent.id));
		const events = mailbox.take((event) => targetIds.has(event.agentId), "consumed");
		for (const event of events) persistMailboxFinal(event, "delivered");
		updateOverlay();
		return events;
	};
	const takeAutomaticMailboxDelivery = (): { events: AgentMailboxEvent<AgentSnapshot>[]; agents: AgentSnapshot[] } | undefined => {
		const events = mailbox.take((event) => {
			const agent = agents.get(event.agentId);
			return Boolean(agent && !agent.suppressNotifications && agent.generation === generation && agent.status !== "closed");
		}, "delivered");
		if (events.length === 0) return undefined;
		const completed = new Map<string, AgentSnapshot>();
		for (const event of events) {
			persistMailboxFinal(event, "delivered");
			if (event.kind !== "final") continue;
			const agent = agents.get(event.agentId);
			if (!agent || agent.completionDelivery !== "none") continue;
			agent.completionDelivery = "automatic";
			completed.set(agent.id, event.final ?? snapshot(agent));
		}
		updateOverlay();
		return { events, agents: [...completed.values()] };
	};
	const mailboxDeliveryMessage = (delivery: { events: AgentMailboxEvent<AgentSnapshot>[]; agents: AgentSnapshot[] }) => {
		const details = { action: "mailbox", agents: delivery.agents, mailbox: delivery.events } satisfies ToolDetails;
		return {
			role: "custom",
			customType: MAILBOX_BATCH_TYPE,
			content: mailboxBatchContent(delivery.events, delivery.agents),
			display: true,
			details,
			timestamp: Date.now(),
		};
	};
	const {
		attachClient,
		closeAgent,
		ensureClient,
		finishRun,
		hibernateAgent,
		interruptAgent,
	} = createAgentLifecycle({
		createClient,
		reportToolName: REPORT_TOOL_NAME,
		maxReportChars: MAX_REPORT_CHARS,
		assertCurrentSession,
		publishMailboxEvent,
		discardMailboxEvents(agent) {
			for (const event of mailbox.peek((candidate) => candidate.agentId === agent.id)) removeMailboxEvent(event);
		},
		recordUsage(agent, message) {
			const persistedUsage = persistedSubagentUsage(message);
			if (!persistedUsage || !sessionActive || agent.generation !== generation) return;
			pi.appendEntry(SUBAGENT_USAGE_ENTRY_TYPE, persistedUsage);
			pi.events.emit(SUBAGENT_USAGE_EVENT, persistedUsage);
		},
		updateOverlay,
		refreshTranscript() { activeTranscriptRefresh?.(); },
		trimClosed,
	});
	const startAgent = async (task: string, ctx: any, contextMode: ContextMode = "fresh", name?: string, signal?: AbortSignal): Promise<ManagedAgent> => {
		const normalizedTask = boundedInput(task, "spawn task", MAX_TASK_CHARS);
		const normalizedName = normalizeAgentName(name, MAX_AGENT_NAME_CHARS);
		const reservation = reserveSpawn(normalizedName);
		const seed = normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || "agent";
		let id: string;
		do { id = `${seed}-${randomBytes(3).toString("hex")}`; } while (agents.has(id));
		let fork: ContextFork | undefined;
		let agent: ManagedAgent | undefined;
		try {
			const compactedSummary = contextMode === "compacted" ? await compactedContextFor(ctx, signal) : undefined;
			fork = await forkContext(ctx, contextMode, compactedSummary);
			assertCurrentSession(reservation.generation);
			const invocation = getPiInvocation(buildArgs(pi, ctx, fork));
			const clientOptions: AgentClientOptions = {
				command: invocation.command,
				args: invocation.args,
				cwd: ctx.cwd,
				env: childEnvironment(id),
			};
			const client = createClient(clientOptions);
			let resolveCompletion!: () => void;
			agent = {
				id,
				name: normalizedName,
				task: normalizedTask,
				contextMode,
				status: "starting",
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				startedAt: Date.now(),
				output: "",
				activity: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				client,
				clientOptions,
				fork,
				completion: new Promise<void>((resolve) => { resolveCompletion = resolve; }),
				resolveCompletion,
				runSettled: false,
				waiting: 0,
				queuedMessages: [],
				pendingReports: new Map(),
				completionDelivery: "none",
				suppressNotifications: false,
				generation: reservation.generation,
				cleanupComplete: false,
				transitioning: false,
			};
			agents.set(id, agent);
			reservation.commit();
			attachClient(agent, client);
			updateOverlay();
			await client.start();
			assertCurrentSession(reservation.generation);
			if (agent.status === "closed") throw new Error("Subagent closed during startup");
			agent.status = "running";
			await client.prompt(childTask(normalizedName, normalizedTask, contextMode));
			assertCurrentSession(reservation.generation);
			updateOverlay();
			return agent;
		} catch (error) {
			if (agent) {
				if (isActive(agent)) finishRun(agent, "failed", error instanceof Error ? error.message : String(error));
				try {
					await closeAgent(agent, true);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Subagent startup and cleanup both failed");
				}
			} else if (fork) {
				try { await fork.cleanup(); }
				catch (cleanupError) { throw new AggregateError([error, cleanupError], "Subagent context creation and cleanup both failed"); }
			}
			throw error;
		} finally {
			reservation.release();
		}
	};
	const waitForAgents = async (
		targets: ManagedAgent[],
		timeoutMs: number,
		returnWhen: WaitReturn,
		wakeOn: WaitWake,
		signal?: AbortSignal,
	): Promise<{ timedOut: boolean; interrupted: boolean }> => {
		const targetIds = new Set(targets.map((agent) => agent.id));
		const hasMailboxActivity = () => mailbox.has((event) => targetIds.has(event.agentId) && (wakeOn === "any" || event.kind === "final"));
		const running = targets.filter(isActive);
		const alreadyWaiting = targets.find((agent) => agent.waiting > 0);
		if (alreadyWaiting) throw new Error(`Agent ${alreadyWaiting.name} already has an active wait`);
		if (running.length === 0 || (returnWhen === "any" && (running.length < targets.length || hasMailboxActivity()))) {
			return { timedOut: false, interrupted: false };
		}
		for (const agent of running) agent.waiting += 1;
		let timedOut = false;
		let interrupted = false;
		try {
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					mailboxListeners.delete(onMailbox);
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => { interrupted = true; finish(); };
				const onMailbox = () => {
					if (returnWhen === "any" && hasMailboxActivity()) finish();
				};
				const timer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);
				mailboxListeners.add(onMailbox);
				const completion = returnWhen === "any"
					? Promise.race(running.map((agent) => agent.completion))
					: Promise.all(running.map((agent) => agent.completion));
				completion.then(finish);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				onMailbox();
			});
		} finally {
			for (const agent of running) agent.waiting = Math.max(0, agent.waiting - 1);
		}
		return { timedOut, interrupted };
	};

	registerSubagentRenderers(pi);

	pi.registerTool({
		name: TOOL_NAME,
		label: "Agents",
		description: "Spawn and coordinate uniquely named child agents with isolated persistent context. Actions: spawn starts one; message queues context without starting an idle child turn; followup steers or resumes a child; send is a legacy followup alias; wait collects mailbox updates using configurable bounds and can wake on any update, final results only, or all selected finals; list shows status; read returns the latest response; interrupt stops the current turn but preserves context; close deletes it. Children inherit the current model, tools, working directory, and project instructions and can report bounded interim progress. Mailbox updates enter the next safe model request, display when idle without starting a turn, and preserve unread finals across reloads.",
		promptSnippet: "Spawn and coordinate isolated child agents for explicitly delegated work",
		promptGuidelines: [
			"Use agents only when the user or applicable project instructions request delegation, subagents, or parallel agent work.",
			"Call agents with action=spawn for concrete independent tasks; give each child a concise task-specific name that is unique in the current session; multiple spawn calls can run concurrently, and the parent should continue useful non-overlapping work.",
			"Agents use fresh conversation context by default. Set context=compacted when prior decisions matter, or context=forked only when the exact parent conversation is required.",
			"Use action=message for queue-only context and action=followup to trigger or steer work; send remains a compatibility alias for followup.",
			"Use agents action=wait only when blocked on child results; it resumes after the first mailbox update by default, accepts wake_on=final when progress must not wake it, and uses return_when=all only when every selected final result is required. Timeouts do not stop agents or force parent turns.",
			"Never ask a healthy running agent to stop or finalize merely because a wait timed out. Continue independent work or wait again; curtail an agent only when it is stuck, mis-scoped, or constrained by a user deadline.",
			"Use agents action=read to retrieve a child's latest response again without restarting it, and action=interrupt to stop active work while preserving the conversation for follow-up.",
			"After collecting a child's final result, call agents with action=close when no further follow-up is needed; settled children hibernate but retain a conversation slot until closed.",
			"Give concurrently writing child agents disjoint file scopes to avoid conflicting edits.",
		],
		parameters: withReasoning({
			type: "object",
			properties: {
				action: { type: "string", enum: ["spawn", "message", "followup", "send", "wait", "list", "read", "interrupt", "close"], description: "Lifecycle action; send is a legacy alias for followup" },
				task: { type: "string", maxLength: MAX_TASK_CHARS, description: "Concrete task for spawn" },
				context: { type: "string", enum: ["fresh", "compacted", "forked"], description: "Conversation context for spawn (default fresh)" },
				name: { type: "string", maxLength: MAX_AGENT_NAME_CHARS, description: "Required unique human-readable name for spawn" },
				agent_name: { type: "string", description: "Agent name for message, followup, send, read, interrupt, or close" },
				message: { type: "string", maxLength: MAX_MESSAGE_CHARS, description: "Queued context or follow-up instruction for message, followup, or send" },
				agent_names: { type: "array", items: { type: "string" }, description: "Agent names for wait; defaults to all running agents" },
				return_when: { type: "string", enum: ["any", "all"], description: `Wait completion condition (default ${DEFAULT_WAIT_RETURN})` },
				wake_on: { type: "string", enum: ["any", "final"], description: `Mailbox event filter when return_when is any (default ${DEFAULT_WAIT_WAKE})` },
				timeout_ms: {
					type: "integer",
					minimum: runtimeConfig.wait.minimumMs,
					maximum: runtimeConfig.wait.maximumMs,
					description: `Wait timeout in milliseconds (default ${runtimeConfig.wait.defaultMs}, min ${runtimeConfig.wait.minimumMs}, max ${runtimeConfig.wait.maximumMs})`,
				},
			},
			required: ["action"],
		} as any),
		prepareArguments(args: any) {
			if (!args || typeof args !== "object") return args;
			const { agent_id, agent_ids, ...current } = args;
			if (current.agent_name === undefined && typeof agent_id === "string") current.agent_name = agent_id;
			if (current.agent_names === undefined && Array.isArray(agent_ids)) current.agent_names = agent_ids;
			return current;
		},
		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			if (params.action === "spawn") {
				const contextMode = params.context ?? "fresh";
				if (!(["fresh", "compacted", "forked"] as const).includes(contextMode)) throw new Error("context must be fresh, compacted, or forked");
				const agent = await startAgent(String(params.task ?? ""), ctx, contextMode, params.name, signal);
				const data = snapshot(agent);
				return {
					content: [{ type: "text", text: `Started ${agent.name} for: ${agent.task}\nContinue non-overlapping work; its result will arrive automatically.` }],
					details: { action: "spawn", agents: [data] } satisfies ToolDetails,
				};
			}
			if (params.action === "send" || params.action === "followup" || params.action === "message") {
				const action = params.action as "send" | "followup" | "message";
				const agent = resolveAgent(String(params.agent_name ?? ""));
				if (!agent) throw new Error(`Agent not found: ${params.agent_name ?? ""}`);
				if (agent.status === "closed" || agent.cleanupComplete) throw new Error(`Agent ${agent.name} is closed`);
				const message = boundedInput(params.message, `${action} message`, MAX_MESSAGE_CHARS);
				const beginFollowUp = async () => {
					if (agent.transitioning) throw new Error(`Agent ${agent.name} is already resuming`);
					agent.transitioning = true;
					const previous = {
						status: agent.status,
						startedAt: agent.startedAt,
						endedAt: agent.endedAt,
						output: agent.output,
						error: agent.error,
						activity: agent.activity,
						queuedMessages: [...agent.queuedMessages],
						completionDelivery: agent.completionDelivery,
						suppressNotifications: agent.suppressNotifications,
						completion: agent.completion,
						resolveCompletion: agent.resolveCompletion,
						runSettled: agent.runSettled,
					};
					try {
						const client = await ensureClient(agent);
						const queued = [...agent.queuedMessages];
						const prompt = queued.length > 0
							? `${queued.map((item) => `Queued message:\n${item}`).join("\n\n")}\n\nFollow-up task:\n${message}`
							: message;
						agent.status = "running";
						agent.startedAt = Date.now();
						agent.endedAt = undefined;
						agent.output = "";
						agent.error = undefined;
						agent.activity = [`follow-up: ${compact(message, 100)}`];
						agent.queuedMessages = [];
						agent.pendingReports.clear();
						for (const event of mailbox.peek((candidate) => candidate.agentId === agent.id)) removeMailboxEvent(event);
						agent.completionDelivery = "none";
						agent.suppressNotifications = false;
						newCompletion(agent);
						const rejectedRunResolve = agent.resolveCompletion;
						updateOverlay();
						const run = client.prompt(prompt);
						agent.transitioning = false;
						try {
							await run;
						} catch (error) {
							if (agent.client === client && isActive(agent) && !agent.runSettled) {
								Object.assign(agent, previous);
								rejectedRunResolve();
								updateOverlay();
								void hibernateAgent(agent).catch(() => { /* Retried by close or followup. */ });
							}
							throw error;
						}
					} finally {
						agent.transitioning = false;
					}
				};
				if (action === "message" && !isActive(agent)) {
					queueChildMessage(agent, message);
					agent.activity.push(`queued message: ${compact(message, 100)}`);
				} else if (isActive(agent)) {
					const client = await ensureClient(agent);
					try {
						await client.steer(message);
						agent.activity.push(`${action === "message" ? "message" : "follow-up"}: ${compact(message, 100)}`);
						if (agent.activity.length > 12) agent.activity.shift();
					} catch (error) {
						if (!isActive(agent) && action !== "message") await beginFollowUp();
						else if (!isActive(agent)) queueChildMessage(agent, message);
						else throw error;
					}
				} else await beginFollowUp();
				updateOverlay();
				const data = snapshot(agent);
				const text = action === "message"
					? `Queued message for ${agent.name} without starting a turn.`
					: `Sent follow-up to ${agent.name}.`;
				return { content: [{ type: "text", text }], details: { action, agents: [data] } satisfies ToolDetails };
			}
			if (params.action === "wait") {
				const requested: string[] = Array.isArray(params.agent_names) ? params.agent_names : [];
				const targets = requested.length > 0
					? requested.map((name) => {
						const agent = resolveAgent(name);
						if (!agent) throw new Error(`Agent not found: ${name}`);
						return agent;
					})
					: orderedAgents().filter(isActive);
				const timeoutMs = params.timeout_ms ?? runtimeConfig.wait.defaultMs;
				if (!Number.isInteger(timeoutMs) || timeoutMs < runtimeConfig.wait.minimumMs || timeoutMs > runtimeConfig.wait.maximumMs) {
					throw new Error(`timeout_ms must be an integer between ${runtimeConfig.wait.minimumMs} and ${runtimeConfig.wait.maximumMs}`);
				}
				const returnWhen: WaitReturn = params.return_when ?? DEFAULT_WAIT_RETURN;
				if (returnWhen !== "any" && returnWhen !== "all") throw new Error("return_when must be any or all");
				const wakeOn: WaitWake = params.wake_on ?? DEFAULT_WAIT_WAKE;
				if (wakeOn !== "any" && wakeOn !== "final") throw new Error("wake_on must be any or final");
				const waited = await waitForAgents(targets, timeoutMs, returnWhen, wakeOn, signal);
				const mailboxEvents = takeMailboxEvents(targets);
				const alreadyReportedAgentIds = targets
					.filter((agent) => agent.completionDelivery === "automatic")
					.map((agent) => agent.id);
				for (const event of mailboxEvents) {
					if (event.kind !== "final") continue;
					const agent = agents.get(event.agentId);
					if (agent && agent.completionDelivery === "none") agent.completionDelivery = "wait";
				}
				for (const agent of targets) {
					if (!isActive(agent) && agent.completionDelivery === "none") agent.completionDelivery = "wait";
				}
				const data = targets.map(snapshot);
				const waitStatus = waited.interrupted
					? "Wait interrupted by new input or cancellation.\n"
					: waited.timedOut
						? mailboxEvents.length > 0 || targets.some((agent) => !isActive(agent))
							? "Wait interval ended before the requested completion condition.\nRunning agents continue and queued updates do not force a parent turn. Do not ask healthy running agents to stop or finalize because of this timeout.\n"
							: "No mailbox update arrived during this wait interval.\nAgents continue running and updates remain queued without forcing a parent turn. Do not ask healthy running agents to stop or finalize because of this timeout.\n"
						: "";
				const mailboxText = formatMailboxEvents(mailboxEvents);
				const text = boundedText([waitStatus.trimEnd(), mailboxText, formatAgents(data, true)].filter(Boolean).join("\n\n"), TOOL_OUTPUT_BYTES);
				return {
					content: [{ type: "text", text }],
					details: { action: "wait", agents: data, mailbox: mailboxEvents, alreadyReportedAgentIds, ...waited } satisfies ToolDetails,
				};
			}
			if (params.action === "list") {
				const data = orderedAgents().map(snapshot);
				return { content: [{ type: "text", text: formatAgents(data, false) }], details: { action: "list", agents: data } satisfies ToolDetails };
			}
			if (params.action === "read") {
				const agent = resolveAgent(String(params.agent_name ?? ""));
				if (!agent) throw new Error(`Agent not found: ${params.agent_name ?? ""}`);
				const data = snapshot(agent);
				return { content: [{ type: "text", text: formatAgent(data, true) }], details: { action: "read", agents: [data] } satisfies ToolDetails };
			}
			if (params.action === "interrupt") {
				const agent = resolveAgent(String(params.agent_name ?? ""));
				if (!agent) throw new Error(`Agent not found: ${params.agent_name ?? ""}`);
				if (agent.transitioning && !isActive(agent)) throw new Error(`Agent ${agent.name} is resuming; retry interrupt after startup settles`);
				const wasActive = isActive(agent);
				await interruptAgent(agent);
				const data = snapshot(agent);
				const text = wasActive
					? `Interrupted ${agent.name}; its conversation remains available for follow-up.`
					: `${agent.name} is already ${agent.status}; no interrupt was needed.`;
				return { content: [{ type: "text", text }], details: { action: "interrupt", agents: [data] } satisfies ToolDetails };
			}
			if (params.action === "close") {
				const agent = resolveAgent(String(params.agent_name ?? ""));
				if (!agent) throw new Error(`Agent not found: ${params.agent_name ?? ""}`);
				await closeAgent(agent);
				const data = snapshot(agent);
				return { content: [{ type: "text", text: `Closed ${agent.name}.` }], details: { action: "close", agents: [data] } satisfies ToolDetails };
			}
			throw new Error(`Unknown agents action: ${params.action}`);
		},
		renderCall: renderAgentCall,
		renderResult: renderAgentResult,
		renderShell: "self",
	});

	pi.registerCommand("agents", {
		description: "Inspect mailbox metrics or open a child transcript",
		handler: async (_args, ctx) => {
			const ordered = orderedAgents();
			const mailboxSnapshot = mailbox.snapshot();
			const mailboxLabel = `✉ Mailbox · ${mailboxStatus(mailboxSnapshot)}`;
			if (ordered.length === 0) {
				ctx.ui.notify(`No subagents in this session. Mailbox: ${mailboxStatus(mailboxSnapshot)}`, "info");
				return;
			}
			const labels = ordered.map((agent) => {
				const unread = mailboxSnapshot.byAgent[agent.name ?? agent.id] ?? 0;
				return `${statusSymbol(agent.status)} ${agent.name ?? agent.id} · ${agent.contextMode} context · ${agent.status}${unread > 0 ? ` · ✉ ${unread}` : ""} · ${compact(agent.task, 72)}`;
			});
			const choices = [mailboxLabel, ...labels];
			const selected = await ctx.ui.select(`Subagents (${ordered.filter(isActive).length} running · ${mailboxSnapshot.unread} unread)`, choices);
			if (!selected) return;
			if (selected === mailboxLabel) {
				ctx.ui.notify(`Mailbox: ${mailboxStatus(mailbox.snapshot())}`, "info");
				return;
			}
			const agent = ordered[labels.indexOf(selected)];
			if (!agent) return;
			if (ctx.mode && ctx.mode !== "tui") {
				ctx.ui.notify(boundedText(formatAgent(snapshot(agent), true), 4 * 1024), agent.status === "failed" ? "error" : "info");
				return;
			}
			await showTranscript(agent, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		generation += 1;
		compactedSnapshot = undefined;
		mailbox.reset();
		activeTurnMailbox.reset();
		activeMailboxAnchor = undefined;
		mailboxListeners.clear();
		sessionActive = true;
		parentRunning = false;
		restoreMailboxFinals(ctx);
		updateOverlay();
		for (const event of mailbox.peek()) queueMicrotask(() => deliverMailboxEvent(event));
	});
	pi.on("before_agent_start", () => {
		const delivery = takeAutomaticMailboxDelivery();
		if (!delivery) return;
		const { role: _role, timestamp: _timestamp, ...message } = mailboxDeliveryMessage(delivery);
		return { message };
	});
	pi.on("agent_start", () => {
		if (!parentRunning) {
			activeTurnMailbox.clear();
			activeMailboxAnchor = undefined;
		}
		parentRunning = true;
	});
	pi.on("context", (event) => {
		const delivery = takeAutomaticMailboxDelivery();
		if (delivery) {
			activeMailboxAnchor ??= event.messages.length;
			for (const mailboxEvent of delivery.events) activeTurnMailbox.publish(mailboxEvent);
			const historyMessage = mailboxDeliveryMessage(delivery);
			pi.appendEntry(MAILBOX_HISTORY_ENTRY_TYPE, { version: 1, details: historyMessage.details });
		}
		const activeEvents = activeTurnMailbox.peek();
		if (activeEvents.length === 0) return;
		const completed = activeEvents.flatMap((mailboxEvent) => mailboxEvent.kind === "final" && mailboxEvent.final ? [mailboxEvent.final] : []);
		const message = mailboxDeliveryMessage({ events: activeEvents, agents: completed });
		const messages = [...event.messages];
		messages.splice(Math.min(activeMailboxAnchor ?? messages.length, messages.length), 0, message);
		return { messages };
	});
	pi.on("agent_settled", () => {
		parentRunning = false;
		activeTurnMailbox.clear();
		activeMailboxAnchor = undefined;
		for (const event of mailbox.peek()) queueMicrotask(() => deliverMailboxEvent(event));
	});
	pi.on("session_shutdown", async () => {
		sessionActive = false;
		parentRunning = false;
		generation += 1;
		compactedSnapshot = undefined;
		mailbox.clear();
		activeTurnMailbox.clear();
		activeMailboxAnchor = undefined;
		mailboxListeners.clear();
		const current = [...agents.values()];
		for (const agent of current) agent.suppressNotifications = true;
		const settled = await Promise.allSettled(current.map((agent) => closeAgent(agent, true)));
		const failures = settled
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		agents.clear();
		overlayCard.unregister();
		if (failures.length > 0) throw new AggregateError(failures, "Failed to clean up one or more subagents");
	});
}
