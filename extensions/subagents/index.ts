import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed, withReasoning } from "../better-native-pi/core.js";
import { BOLD, GREEN, MAGENTA, RED, RESET } from "../better-native-pi/render.js";
import { registerOverlayCard } from "../overlay-stack/index.js";
import { createContextFork, type ContextFork } from "./context.js";
import {
	RpcProcessClient,
	childEnvironment,
	getPiInvocation,
	isSubagentChild,
	type AgentClient,
	type AgentClientFactory,
	type AgentClientOptions,
	type RpcAgentEvent,
} from "./rpc.js";

const TOOL_NAME = "agents";
const COMPLETION_MESSAGE_TYPE = "subagent-result";
const STATUS_KEY = "subagents";
const DEFAULT_MAX_AGENTS = 6;
const MAX_RETAINED_CLOSED = 20;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;
const RESULT_BYTES = 24 * 1024;
const TOOL_OUTPUT_BYTES = 48 * 1024;
const TOOL_BRANCH = "  └ ";
const TOOL_INDENT = "    ";
const OVERLAY_WIDTH = 58;
const OVERLAY_MAX_ROWS = 6;

const CHILD_PROMPT = `You are a delegated child agent working in an isolated conversation.
Complete only the explicit task below. The inherited conversation is context, not a request to continue unrelated work.
Work autonomously with the available tools. Return a concise final result with relevant file paths, commands, findings, or remaining blockers.
Do not ask the user questions; report any missing information to the parent agent.`;

export type AgentStatus = "starting" | "running" | "completed" | "failed" | "closed";

interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface AgentSnapshot {
	id: string;
	task: string;
	status: AgentStatus;
	cwd: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	output: string;
	error?: string;
	activity: string[];
	usage: AgentUsage;
}

interface ManagedAgent extends AgentSnapshot {
	client?: AgentClient;
	fork: ContextFork;
	completion: Promise<void>;
	resolveCompletion: () => void;
	runSettled: boolean;
	waiting: number;
	suppressNotifications: boolean;
	generation: number;
}

interface ToolDetails {
	action: string;
	agents: AgentSnapshot[];
	timedOut?: boolean;
	interrupted?: boolean;
}

export interface SubagentsOptions {
	createClient?: AgentClientFactory;
	registerOverlayCard?: typeof registerOverlayCard;
	maxAgents?: number;
}

function sanitizeTerminal(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function compact(text: string, limit = 100): string {
	const oneLine = sanitizeTerminal(text).replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

export function boundedText(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const marker = "\n\n[... output omitted ...]\n\n";
	const available = Math.max(0, maxBytes - Buffer.byteLength(marker));
	let head = text.slice(0, Math.floor(available / 3));
	let tail = text.slice(-Math.ceil(available * 2 / 3));
	while (Buffer.byteLength(head + marker + tail) > maxBytes && tail.length > 0) tail = tail.slice(1);
	while (Buffer.byteLength(head + marker + tail) > maxBytes && head.length > 0) head = head.slice(0, -1);
	return head + marker + tail;
}

function durationText(startedAt: number, endedAt = Date.now()): string {
	return formatElapsed(Math.max(0, endedAt - startedAt));
}

function tokenText(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count / 1_000)}k`;
}

function usageText(agent: AgentSnapshot): string {
	const parts: string[] = [];
	if (agent.usage.turns) parts.push(`${agent.usage.turns} turn${agent.usage.turns === 1 ? "" : "s"}`);
	if (agent.usage.input) parts.push(`↑${tokenText(agent.usage.input)}`);
	if (agent.usage.output) parts.push(`↓${tokenText(agent.usage.output)}`);
	if (agent.usage.cacheRead) parts.push(`R${tokenText(agent.usage.cacheRead)}`);
	if (agent.usage.cost) parts.push(`$${agent.usage.cost.toFixed(4)}`);
	if (agent.model) parts.push(agent.model);
	return parts.join(" · ");
}

function statusSymbol(status: AgentStatus): string {
	if (status === "starting" || status === "running") return "●";
	if (status === "completed") return "✓";
	if (status === "failed") return "×";
	return "■";
}

function statusColor(status: AgentStatus): string {
	if (status === "starting" || status === "running") return "accent";
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	return "muted";
}

function compactAgentId(id: string, width: number): string {
	if (visibleWidth(id) <= width) return id;
	if (width < 9) return truncateToWidth(id, width, "…");
	const suffix = id.slice(-7);
	return `${truncateToWidth(id, Math.max(1, width - visibleWidth(suffix) - 1), "")}…${suffix}`;
}

function overlayAgentDetail(agent: AgentSnapshot): string {
	if (agent.status === "completed") return "completed";
	if (agent.status === "failed") return compact(agent.error || "failed", 160);
	return compact(agent.activity.at(-1) || agent.task || agent.status, 160);
}

function renderOverlayAgent(agent: AgentSnapshot, width: number, theme: any): string {
	const mark = theme.fg(statusColor(agent.status), statusSymbol(agent.status));
	const idWidth = Math.max(8, Math.min(22, Math.floor(width * 0.42)));
	const identity = `${mark} ${theme.bold(compactAgentId(agent.id, idWidth))}`;
	const elapsed = theme.fg("dim", durationText(agent.startedAt, agent.endedAt));
	const detailWidth = Math.max(0, width - visibleWidth(identity) - visibleWidth(elapsed) - 2);
	const detailText = detailWidth > 3 ? truncateToWidth(overlayAgentDetail(agent), detailWidth, "…") : "";
	const detail = agent.status === "completed"
		? theme.fg("success", detailText)
		: agent.status === "failed"
			? theme.fg("error", detailText)
			: theme.fg("dim", detailText);
	return truncateToWidth([identity, elapsed, detail].filter(Boolean).join(" "), width, "…");
}

export function renderAgentsOverlayBody(agents: AgentSnapshot[], width: number, maxHeight: number, theme: any): string[] {
	const rowBudget = Math.max(0, Math.min(OVERLAY_MAX_ROWS, maxHeight));
	if (rowBudget === 0 || agents.length === 0) return [];
	const reserveOverflow = agents.length > rowBudget && rowBudget > 1;
	const shown = agents.slice(0, reserveOverflow ? rowBudget - 1 : rowBudget);
	const lines = shown.map((agent) => renderOverlayAgent(agent, width, theme));
	const hidden = agents.length - shown.length;
	if (reserveOverflow && hidden > 0) lines.push(theme.fg("dim", `… ${hidden} more · /agents`));
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

function isActive(agent: Pick<ManagedAgent, "status">): boolean {
	return agent.status === "starting" || agent.status === "running";
}

function assistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return sanitizeTerminal(message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim());
}

function newCompletion(agent: ManagedAgent): void {
	agent.runSettled = false;
	agent.completion = new Promise<void>((resolve) => { agent.resolveCompletion = resolve; });
}

function snapshot(agent: ManagedAgent): AgentSnapshot {
	return {
		id: agent.id,
		task: agent.task,
		status: agent.status,
		cwd: agent.cwd,
		model: agent.model,
		startedAt: agent.startedAt,
		endedAt: agent.endedAt,
		output: boundedText(agent.output, RESULT_BYTES),
		error: agent.error,
		activity: [...agent.activity],
		usage: { ...agent.usage },
	};
}

function formatAgent(agent: AgentSnapshot, includeOutput: boolean): string {
	const elapsed = durationText(agent.startedAt, agent.endedAt);
	const lines = [`${statusSymbol(agent.status)} ${agent.id} · ${agent.status} · ${elapsed}`, `task: ${sanitizeTerminal(agent.task)}`];
	if (agent.error) lines.push(`error: ${agent.error}`);
	const usage = usageText(agent);
	if (usage) lines.push(`usage: ${usage}`);
	if (includeOutput && agent.output) lines.push("", "result:", agent.output);
	else if (includeOutput && isActive(agent as any)) lines.push("", "(still running)");
	return lines.join("\n");
}

function formatAgents(agents: AgentSnapshot[], includeOutput: boolean): string {
	if (agents.length === 0) return "No subagents in this session.";
	return boundedText(agents.map((agent) => formatAgent(agent, includeOutput)).join("\n\n---\n\n"), TOOL_OUTPUT_BYTES);
}

function buildArgs(pi: ExtensionAPI, ctx: any, fork: ContextFork): string[] {
	const args = ["--mode", "rpc", "--session", fork.sessionFile, "--session-dir", fork.directory];
	if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	const thinking = pi.getThinkingLevel();
	if (thinking) args.push("--thinking", thinking);
	const tools = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
	if (tools.length > 0) args.push("--tools", tools.join(","));
	else args.push("--no-tools");
	return args;
}

function childTask(id: string, task: string): string {
	return `${CHILD_PROMPT}\n\nChild agent id: ${id}\n\nTask:\n${task.trim()}`;
}

function messageContent(agent: AgentSnapshot): string {
	return boundedText([
		`<subagent_result id="${agent.id}" status="${agent.status}">`,
		`Task: ${sanitizeTerminal(agent.task)}`,
		agent.error ? `Error: ${agent.error}` : "",
		agent.output ? `Result:\n${agent.output}` : "Result: (no final text)",
		"</subagent_result>",
	].filter(Boolean).join("\n\n"), RESULT_BYTES);
}

interface ToolRenderContext {
	lastComponent?: unknown;
	args?: Record<string, unknown>;
	isPartial?: boolean;
	isError?: boolean;
}

interface ToolRenderOptions {
	expanded?: boolean;
	isPartial?: boolean;
}

class AgentToolLines implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	constructor(private source: (width: number) => string[] = () => []) {}
	update(source: (width: number) => string[]): void {
		this.source = source;
		this.invalidate();
	}
	render(width: number): string[] {
		const max = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === max) return this.cachedLines;
		this.cachedLines = this.source(max).map((line) => visibleWidth(line) <= max ? line : fitToolLine(line, max));
		this.cachedWidth = max;
		return this.cachedLines;
	}
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function reuseAgentToolLines(context: ToolRenderContext | undefined): AgentToolLines {
	return context?.lastComponent instanceof AgentToolLines ? context.lastComponent : new AgentToolLines();
}

function toolHeadline(partial: boolean, isError: boolean, verb: string, detail: string): string {
	const mark = partial ? `${MAGENTA}•${RESET}` : isError ? `${RED}•${RESET}` : `${GREEN}•${RESET}`;
	return `${mark} ${BOLD}${verb}${RESET}${detail ? ` ${detail}` : ""}`;
}

function actionVerb(action: unknown, partial: boolean, details?: ToolDetails): string {
	if (action === "spawn") return partial ? "Spawning agent" : "Spawned agent";
	if (action === "send") return partial ? "Sending to agent" : "Sent to agent";
	if (action === "wait") {
		if (!partial && details?.interrupted) return "Wait interrupted";
		if (!partial && details?.timedOut) return "Wait timed out";
		return partial ? "Waiting for agents" : "Waited for agents";
	}
	if (action === "list") return partial ? "Listing agents" : "Listed agents";
	if (action === "close") return partial ? "Closing agent" : "Closed agent";
	return partial ? "Using agents" : "Used agents";
}

function actionDetail(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	if (args.action === "spawn") return compact(String(args.task ?? ""), 180);
	if (args.action === "send") return [compact(String(args.agent_id ?? ""), 48), compact(String(args.message ?? ""), 120)].filter(Boolean).join(" · ");
	if (args.action === "wait") {
		const ids = Array.isArray(args.agent_ids) && args.agent_ids.length ? args.agent_ids.join(", ") : "running agents";
		const timeout = Number.isInteger(args.timeout_ms)
			? (args.timeout_ms === 0 ? "no wait" : `${formatElapsed(args.timeout_ms as number)} timeout`)
			: "";
		return [compact(ids, 120), timeout].filter(Boolean).join(" · ");
	}
	if (args.action === "list") return "current session";
	return compact(String(args.agent_id ?? ""), 80);
}

function reasoningDetail(args: Record<string, unknown> | undefined, theme: any, partial: boolean): string {
	const reasoning = compact(String(args?.reasoning ?? ""), 100);
	if (reasoning) return theme.fg("accent", reasoning);
	return partial ? theme.fg("dim", "…") : "";
}

function agentSummary(agent: AgentSnapshot, width: number, theme: any): string {
	const mark = theme.fg(statusColor(agent.status), statusSymbol(agent.status));
	const identity = `${mark} ${theme.bold(agent.id)} ${theme.fg("dim", `· ${agent.status} · ${durationText(agent.startedAt, agent.endedAt)}`)}`;
	const taskWidth = Math.max(0, width - visibleWidth(TOOL_BRANCH) - visibleWidth(identity) - visibleWidth(" · "));
	const task = taskWidth > 3 ? truncateToWidth(compact(agent.task, 240), taskWidth, "…") : "";
	return `${identity}${task ? ` ${theme.fg("dim", `· ${task}`)}` : ""}`;
}

function expandedAgentLines(agent: AgentSnapshot, width: number, theme: any, includeUsage = true): string[] {
	const lines: string[] = [];
	const usage = includeUsage ? usageText(agent) : "";
	if (usage) lines.push(`${TOOL_INDENT}${theme.fg("dim", usage)}`);
	if (agent.error) lines.push(`${TOOL_INDENT}${theme.fg("error", compact(agent.error, 240))}`);
	if (agent.output) {
		const contentWidth = Math.max(1, width - visibleWidth(TOOL_INDENT));
		lines.push(...new Markdown(agent.output, 0, 0, getMarkdownTheme()).render(contentWidth).map((line) => `${TOOL_INDENT}${line}`));
	} else if (agent.status === "starting" || agent.status === "running") {
		lines.push(`${TOOL_INDENT}${theme.fg("dim", "still running")}`);
	}
	return lines;
}

function resultText(result: any): string {
	return result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
}

function renderAgentCall(args: Record<string, unknown>, theme: any, context: ToolRenderContext) {
	if (!context?.isPartial) return new Container();
	const component = reuseAgentToolLines(context);
	component.update(() => {
		const detail = actionDetail(args);
		return [
			toolHeadline(true, false, actionVerb(args.action, true), reasoningDetail(args, theme, true)),
			...(detail ? [`${TOOL_BRANCH}${theme.fg("dim", detail)}`] : []),
		];
	});
	return component;
}

function renderAgentResult(result: any, options: ToolRenderOptions, theme: any, context: ToolRenderContext) {
	if (options?.isPartial) return new Container();
	const component = reuseAgentToolLines(context);
	const details = result?.details as ToolDetails | undefined;
	const args = context?.args;
	const action = details?.action ?? args?.action;
	const fallback = resultText(result);
	component.update((width) => {
		if (context?.isError) {
			return [
				toolHeadline(false, true, "Agent action failed", reasoningDetail(args, theme, false)),
				`${TOOL_BRANCH}${theme.fg("error", compact(fallback || "Unknown agent error", 240))}`,
			];
		}
		const lines = [toolHeadline(false, false, actionVerb(action, false, details), reasoningDetail(args, theme, false))];
		if (!details?.agents?.length) {
			lines.push(`${TOOL_BRANCH}${theme.fg("dim", action === "wait" ? "no running agents" : "no agents in this session")}`);
			return lines;
		}
		for (const agent of details.agents) {
			lines.push(`${TOOL_BRANCH}${agentSummary(agent, width, theme)}`);
			if (options?.expanded) lines.push(...expandedAgentLines(agent, width, theme));
		}
		return lines;
	});
	return component;
}

class CompletionComponent implements Component {
	private readonly component: AgentToolLines;
	constructor(agent: AgentSnapshot, expanded: boolean, theme: any) {
		this.component = new AgentToolLines((width) => {
			const failed = agent.status === "failed";
			const detail = theme.fg("accent", theme.bold(agent.id));
			const metadata = [compact(agent.task, 180), durationText(agent.startedAt, agent.endedAt), usageText(agent)].filter(Boolean).join(" · ");
			const lines = [
				toolHeadline(false, failed, failed ? "Agent failed" : "Agent completed", detail),
				`${TOOL_BRANCH}${theme.fg("dim", metadata)}`,
			];
			if (agent.error) lines.push(`${TOOL_INDENT}${theme.fg("error", compact(agent.error, 240))}`);
			if (expanded && agent.output) lines.push(...expandedAgentLines({ ...agent, error: undefined }, width, theme, false));
			return lines;
		});
	}
	render(width: number): string[] { return this.component.render(width); }
	invalidate(): void { this.component.invalidate(); }
}

export default function registerSubagents(pi: ExtensionAPI, options: SubagentsOptions = {}) {
	if (isSubagentChild()) return;
	const agents = new Map<string, ManagedAgent>();
	const createClient = options.createClient ?? ((clientOptions: AgentClientOptions) => new RpcProcessClient(clientOptions));
	const registerCard = options.registerOverlayCard ?? registerOverlayCard;
	const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
	let activeCtx: any;
	let generation = 0;

	const openAgents = () => [...agents.values()].filter((agent) => agent.client && agent.status !== "closed");
	const orderedAgents = () => [...agents.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt);
	const displayedAgents = () => orderedAgents().filter((agent) => agent.client && agent.status !== "closed");
	const overlayCard = registerCard({
		id: "subagents",
		order: 15,
		width: OVERLAY_WIDTH,
		minBodyHeight: 1,
		minTerminalWidth: 90,
		minTerminalHeight: 10,
		visible: () => displayedAgents().length > 0,
		title: (theme) => {
			const displayed = displayedAgents();
			const running = displayed.filter(isActive).length;
			const completed = displayed.filter((agent) => agent.status === "completed").length;
			const failed = displayed.filter((agent) => agent.status === "failed").length;
			const parts = [
				running ? theme.fg("accent", `● ${running} running`) : "",
				completed ? theme.fg("success", `✓ ${completed} done`) : "",
				failed ? theme.fg("error", `× ${failed} failed`) : "",
			].filter(Boolean);
			return `${theme.bold(" Agents ")}${parts.join(theme.fg("dim", " · "))} `;
		},
		renderBody: (width, maxHeight, theme) => renderAgentsOverlayBody(displayedAgents().map(snapshot), width, maxHeight, theme),
	});
	const updateStatus = () => {
		overlayCard.invalidate();
		if (!activeCtx) return;
		const count = [...agents.values()].filter(isActive).length;
		activeCtx.ui.setStatus(STATUS_KEY, count > 0 ? `${count} subagent${count === 1 ? "" : "s"} running · /agents to view` : undefined);
	};
	const resolveAgent = (idOrPrefix: string): ManagedAgent | undefined => {
		const query = idOrPrefix.trim();
		if (!query) return undefined;
		if (agents.has(query)) return agents.get(query);
		const matches = [...agents.values()].filter((agent) => agent.id.startsWith(query));
		return matches.length === 1 ? matches[0] : undefined;
	};
	const trimClosed = () => {
		const closed = [...agents.values()].filter((agent) => agent.status === "closed").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		while (closed.length > MAX_RETAINED_CLOSED) {
			const oldest = closed.shift();
			if (oldest) agents.delete(oldest.id);
		}
	};
	const notifyCompletion = (agent: ManagedAgent) => {
		if (agent.suppressNotifications || agent.waiting > 0 || agent.generation !== generation || agent.status === "closed") return;
		const data = snapshot(agent);
		try {
			pi.sendMessage({
				customType: COMPLETION_MESSAGE_TYPE,
				content: messageContent(data),
				display: true,
				details: data,
			}, { deliverAs: "steer", triggerTurn: true });
		} catch { /* session may be shutting down */ }
	};
	const finishRun = (agent: ManagedAgent, status: "completed" | "failed", error?: string) => {
		if (agent.runSettled || agent.status === "closed") return;
		agent.runSettled = true;
		agent.status = status;
		agent.endedAt = Date.now();
		if (error) agent.error = boundedText(sanitizeTerminal(error), 4 * 1024);
		agent.resolveCompletion();
		updateStatus();
		queueMicrotask(() => notifyCompletion(agent));
	};
	const handleEvent = (agent: ManagedAgent, event: RpcAgentEvent) => {
		if (event.type === "agent_start") {
			agent.status = "running";
			updateStatus();
			return;
		}
		if (event.type === "tool_execution_start") {
			const description = `${event.toolName ?? "tool"}${event.args?.command ? `: ${compact(event.args.command, 100)}` : ""}`;
			agent.activity.push(description);
			if (agent.activity.length > 12) agent.activity.shift();
			overlayCard.invalidate();
			return;
		}
		if ((event.type === "message_update" || event.type === "message_end") && event.message?.role === "assistant") {
			const text = assistantText(event.message);
			if (text) agent.output = boundedText(text, RESULT_BYTES);
			if (event.type === "message_end") {
				agent.usage.turns += 1;
				const usage = event.message.usage;
				if (usage) {
					agent.usage.input += usage.input || 0;
					agent.usage.output += usage.output || 0;
					agent.usage.cacheRead += usage.cacheRead || 0;
					agent.usage.cacheWrite += usage.cacheWrite || 0;
					agent.usage.cost += usage.cost?.total || 0;
				}
				if (event.message.provider && event.message.model) agent.model = `${event.message.provider}/${event.message.model}`;
				if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
					agent.error = event.message.errorMessage || `Agent ${event.message.stopReason}`;
				}
			}
			return;
		}
		if (event.type === "extension_error") {
			agent.activity.push(`extension error: ${event.error ?? "unknown"}`);
			if (agent.activity.length > 12) agent.activity.shift();
			overlayCard.invalidate();
		}
		if (event.type === "agent_settled") finishRun(agent, agent.error ? "failed" : "completed", agent.error);
	};
	const closeAgent = async (agent: ManagedAgent, suppressNotification = true) => {
		if (agent.status === "closed") return;
		agent.suppressNotifications ||= suppressNotification;
		agent.status = "closed";
		agent.endedAt ??= Date.now();
		if (!agent.runSettled) {
			agent.runSettled = true;
			agent.resolveCompletion();
		}
		const client = agent.client;
		agent.client = undefined;
		try { await client?.stop(); } finally { await agent.fork.cleanup(); }
		updateStatus();
		trimClosed();
	};
	const startAgent = async (task: string, ctx: any): Promise<ManagedAgent> => {
		if (openAgents().length >= maxAgents) throw new Error(`At most ${maxAgents} subagents may remain open; close one before spawning another`);
		const normalizedTask = task.trim();
		if (!normalizedTask) throw new Error("spawn requires a non-empty task");
		const seed = normalizedTask.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || "agent";
		let id: string;
		do { id = `${seed}-${randomBytes(3).toString("hex")}`; } while (agents.has(id));
		const fork = await createContextFork(ctx);
		let client: AgentClient;
		let agent: ManagedAgent;
		try {
			const invocation = getPiInvocation(buildArgs(pi, ctx, fork));
			client = createClient({
				command: invocation.command,
				args: invocation.args,
				cwd: ctx.cwd,
				env: childEnvironment(id),
			});
			let resolveCompletion!: () => void;
			agent = {
				id,
				task: normalizedTask,
				status: "starting",
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				startedAt: Date.now(),
				output: "",
				activity: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				client,
				fork,
				completion: new Promise<void>((resolve) => { resolveCompletion = resolve; }),
				resolveCompletion,
				runSettled: false,
				waiting: 0,
				suppressNotifications: false,
				generation,
			};
			agents.set(id, agent);
			client.onEvent((event) => handleEvent(agent, event));
			client.onExit((error) => {
				agent.client = undefined;
				void agent.fork.cleanup().then(
					() => {
						if (isActive(agent)) finishRun(agent, "failed", error.message);
						else if (agent.status !== "closed") { agent.status = "closed"; agent.endedAt ??= Date.now(); updateStatus(); }
					},
					(cleanupError) => {
						const message = `${error.message}; context cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
						if (isActive(agent)) finishRun(agent, "failed", message);
						else if (agent.status !== "closed") { agent.status = "closed"; agent.error = message; agent.endedAt ??= Date.now(); updateStatus(); }
					},
				);
			});
		} catch (error) {
			agents.delete(id);
			await fork.cleanup();
			throw error;
		}
		updateStatus();
		try {
			await client.start();
			agent.status = "running";
			await client.prompt(childTask(id, normalizedTask));
			updateStatus();
			return agent;
		} catch (error) {
			finishRun(agent, "failed", error instanceof Error ? error.message : String(error));
			await closeAgent(agent, true);
			throw error;
		}
	};
	const waitForAgents = async (targets: ManagedAgent[], timeoutMs: number, signal?: AbortSignal): Promise<{ timedOut: boolean; interrupted: boolean }> => {
		const running = targets.filter(isActive);
		if (running.length === 0) return { timedOut: false, interrupted: false };
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
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => { interrupted = true; finish(); };
				const timer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);
				Promise.all(running.map((agent) => agent.completion)).then(finish);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			for (const agent of running) agent.waiting = Math.max(0, agent.waiting - 1);
		}
		return { timedOut, interrupted };
	};

	pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message: any, options: any, theme: any) => {
		const data = message.details as AgentSnapshot | undefined;
		return data ? new CompletionComponent(data, Boolean(options.expanded), theme) : new Text(String(message.content ?? ""), 0, 0);
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Agents",
		description: "Spawn and coordinate generic child agents with isolated persistent context. Actions: spawn starts one and returns its ID immediately; send continues it; wait collects one or more results; list shows status; close stops and releases it. Children inherit the current model, tools, working directory, project instructions, and conversation context. Completion results also arrive automatically.",
		promptSnippet: "Spawn and coordinate isolated child agents for explicitly delegated work",
		promptGuidelines: [
			"Use agents only when the user or applicable project instructions request delegation, subagents, or parallel agent work.",
			"Call agents with action=spawn for concrete independent tasks; multiple spawn calls can run concurrently, and the parent should continue useful non-overlapping work.",
			"Use agents action=wait only when blocked on child results; completed children report back automatically.",
			"Give concurrently writing child agents disjoint file scopes to avoid conflicting edits.",
		],
		parameters: withReasoning({
			type: "object",
			properties: {
				action: { type: "string", enum: ["spawn", "send", "wait", "list", "close"], description: "Lifecycle action" },
				task: { type: "string", description: "Concrete task for spawn" },
				agent_id: { type: "string", description: "Agent ID or unambiguous prefix for send or close" },
				message: { type: "string", description: "Follow-up instruction for send" },
				agent_ids: { type: "array", items: { type: "string" }, description: "Agent IDs or prefixes for wait; defaults to all running agents" },
				timeout_ms: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: `Wait timeout in milliseconds (default ${DEFAULT_WAIT_MS})` },
			},
			required: ["action"],
		} as any),
		async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
			if (params.action === "spawn") {
				const agent = await startAgent(String(params.task ?? ""), ctx);
				const data = snapshot(agent);
				return {
					content: [{ type: "text", text: `Started ${agent.id} for: ${agent.task}\nContinue non-overlapping work; its result will arrive automatically.` }],
					details: { action: "spawn", agents: [data] } satisfies ToolDetails,
				};
			}
			if (params.action === "send") {
				const agent = resolveAgent(String(params.agent_id ?? ""));
				if (!agent) throw new Error(`Subagent not found or prefix is ambiguous: ${params.agent_id ?? ""}`);
				if (!agent.client || agent.status === "closed") throw new Error(`Subagent ${agent.id} is closed`);
				const message = String(params.message ?? "").trim();
				if (!message) throw new Error("send requires a non-empty message");
				const beginFollowUp = async () => {
					agent.status = "running";
					agent.startedAt = Date.now();
					agent.endedAt = undefined;
					agent.output = "";
					agent.error = undefined;
					agent.activity = [`follow-up: ${compact(message, 100)}`];
					agent.suppressNotifications = false;
					newCompletion(agent);
					updateStatus();
					await agent.client!.prompt(message);
				};
				try {
					if (isActive(agent)) {
						try {
							await agent.client.steer(message);
							agent.activity.push(`steered: ${compact(message, 100)}`);
							if (agent.activity.length > 12) agent.activity.shift();
						} catch (error) {
							// The child may settle between our status check and the RPC
							// command. In that case continue it as a fresh prompt.
							if (!isActive(agent) && agent.client) await beginFollowUp();
							else throw error;
						}
					} else await beginFollowUp();
				} catch (error) {
					if (isActive(agent)) finishRun(agent, "failed", error instanceof Error ? error.message : String(error));
					throw error;
				}
				updateStatus();
				const data = snapshot(agent);
				return { content: [{ type: "text", text: `Sent follow-up to ${agent.id}.` }], details: { action: "send", agents: [data] } satisfies ToolDetails };
			}
			if (params.action === "wait") {
				const requested: string[] = Array.isArray(params.agent_ids) ? params.agent_ids : [];
				const targets = requested.length > 0
					? requested.map((id) => {
						const agent = resolveAgent(id);
						if (!agent) throw new Error(`Subagent not found or prefix is ambiguous: ${id}`);
						return agent;
					})
					: orderedAgents().filter(isActive);
				const timeoutMs = params.timeout_ms ?? DEFAULT_WAIT_MS;
				if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new Error(`timeout_ms must be an integer between 0 and ${MAX_WAIT_MS}`);
				const waited = await waitForAgents(targets, timeoutMs, signal);
				const data = targets.map(snapshot);
				return {
					content: [{ type: "text", text: `${waited.interrupted ? "Wait interrupted.\n" : waited.timedOut ? "Wait timed out.\n" : ""}${formatAgents(data, true)}` }],
					details: { action: "wait", agents: data, ...waited } satisfies ToolDetails,
				};
			}
			if (params.action === "list") {
				const data = orderedAgents().map(snapshot);
				return { content: [{ type: "text", text: formatAgents(data, false) }], details: { action: "list", agents: data } satisfies ToolDetails };
			}
			if (params.action === "close") {
				const agent = resolveAgent(String(params.agent_id ?? ""));
				if (!agent) throw new Error(`Subagent not found or prefix is ambiguous: ${params.agent_id ?? ""}`);
				await closeAgent(agent);
				const data = snapshot(agent);
				return { content: [{ type: "text", text: `Closed ${agent.id}.` }], details: { action: "close", agents: [data] } satisfies ToolDetails };
			}
			throw new Error(`Unknown agents action: ${params.action}`);
		},
		renderCall: renderAgentCall,
		renderResult: renderAgentResult,
		renderShell: "self",
	});

	pi.registerCommand("agents", {
		description: "List and inspect child agents",
		handler: async (_args, ctx) => {
			const ordered = orderedAgents();
			if (ordered.length === 0) {
				ctx.ui.notify("No subagents in this session.", "info");
				return;
			}
			const labels = ordered.map((agent) => `${statusSymbol(agent.status)} ${agent.id} · ${agent.status} · ${compact(agent.task, 72)}`);
			const selected = await ctx.ui.select(`Subagents (${ordered.filter(isActive).length} running)`, labels);
			if (!selected) return;
			const agent = ordered[labels.indexOf(selected)];
			if (agent) ctx.ui.notify(boundedText(formatAgent(snapshot(agent), true), 4 * 1024), agent.status === "failed" ? "error" : "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		generation += 1;
		activeCtx = ctx;
		updateStatus();
	});
	pi.on("session_shutdown", async () => {
		generation += 1;
		const current = [...agents.values()];
		for (const agent of current) agent.suppressNotifications = true;
		await Promise.all(current.map((agent) => closeAgent(agent, true)));
		activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		agents.clear();
		overlayCard.unregister();
		activeCtx = undefined;
	});
}
