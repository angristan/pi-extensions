import { randomBytes } from "node:crypto";
import { getMarkdownTheme, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed, withReasoning } from "../better-native-pi/core.js";
import { BOLD, GREEN, MAGENTA, RED, RESET } from "../better-native-pi/render.js";
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
	type AgentClient,
	type AgentClientFactory,
	type AgentClientOptions,
	type RpcAgentEvent,
} from "./rpc.js";
import { SUBAGENT_USAGE_ENTRY_TYPE, SUBAGENT_USAGE_EVENT, persistedSubagentUsage } from "./usage.js";

const TOOL_NAME = "agents";
const COMPLETION_MESSAGE_TYPE = "subagent-result";
const DEFAULT_MAX_AGENTS = 6;
const MAX_RETAINED_CLOSED = 20;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;
const RESULT_BYTES = 24 * 1024;
const TOOL_OUTPUT_BYTES = 48 * 1024;
const MAX_TASK_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_AGENT_NAME_CHARS = 80;
const RESULT_PREVIEW_CHARS = 180;
const TOOL_BRANCH = "  └ ";
const TOOL_INDENT = "    ";
const OVERLAY_WIDTH = 58;
const OVERLAY_AGENT_ROWS = 3;
const OVERLAY_MAX_ROWS = 10;

const CHILD_PROMPT = `You are a delegated child agent working in an isolated conversation.
Complete only the explicit task below.
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
	name?: string;
	task: string;
	contextMode: ContextMode;
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
	completionDelivery: "none" | "automatic" | "wait";
	suppressNotifications: boolean;
	generation: number;
	cleanupComplete: boolean;
	closePromise?: Promise<void>;
}

interface ToolDetails {
	action: string;
	agents: AgentSnapshot[];
	alreadyReportedAgentIds?: string[];
	timedOut?: boolean;
	interrupted?: boolean;
}

export interface SubagentsOptions {
	createClient?: AgentClientFactory;
	createContextFork?: typeof createContextFork;
	compactContext?: CompactContext;
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

function boundedInput(value: unknown, label: string, maxChars: number): string {
	const text = String(value ?? "").trim();
	if (!text) throw new Error(`${label} requires non-empty text`);
	if (text.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
	return text;
}

function normalizeAgentName(value: unknown): string {
	if (typeof value !== "string") throw new Error("spawn requires an agent name");
	const name = sanitizeTerminal(value).replace(/\s+/g, " ").trim();
	if (!name) throw new Error("spawn requires an agent name");
	if (name.length > MAX_AGENT_NAME_CHARS) throw new Error(`agent name must be at most ${MAX_AGENT_NAME_CHARS} characters`);
	return name;
}

function agentNameKey(name: string): string {
	return name.toLowerCase();
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
	if (agent.usage.cacheWrite) parts.push(`W${tokenText(agent.usage.cacheWrite)}`);
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

function overlayTokenCount(agent: AgentSnapshot): number {
	return agent.usage.input + agent.usage.output + agent.usage.cacheRead + agent.usage.cacheWrite;
}

function overlayAgentDetail(agent: AgentSnapshot): string {
	if (agent.status === "completed") return "completed · /agents";
	if (agent.status === "failed") return `${compact(agent.error || "failed", 140)} · /agents`;
	return compact(agent.activity.at(-1) || (agent.status === "starting" ? "starting" : "working"), 160);
}

function renderOverlayAgent(agent: AgentSnapshot, width: number, theme: any): string[] {
	const mark = theme.fg(statusColor(agent.status), statusSymbol(agent.status));
	const metadata = theme.fg("muted", `${tokenText(overlayTokenCount(agent))} tok`);
	const idWidth = Math.max(8, width - visibleWidth(mark) - visibleWidth(metadata) - 3);
	const identity = `${mark} ${theme.bold(compact(agent.name ?? agent.id, idWidth))}`;
	const gap = " ".repeat(Math.max(1, width - visibleWidth(identity) - visibleWidth(metadata)));
	const headline = truncateToWidth(`${identity}${gap}${metadata}`, width, "…");

	const taskPrefix = "  ";
	const task = truncateToWidth(compact(agent.task, 240), Math.max(1, width - visibleWidth(taskPrefix)), "…");
	const taskLine = truncateToWidth(`${taskPrefix}${theme.fg("text", task)}`, width, "…");

	const activityPrefix = theme.fg("dim", "  ↳ ");
	const activityWidth = Math.max(1, width - visibleWidth(activityPrefix));
	const activityText = truncateToWidth(overlayAgentDetail(agent), activityWidth, "…");
	const activity = agent.status === "completed"
		? theme.fg("success", activityText)
		: agent.status === "failed"
			? theme.fg("error", activityText)
			: theme.fg("dim", activityText);
	const activityLine = truncateToWidth(`${activityPrefix}${activity}`, width, "…");
	return [headline, taskLine, activityLine];
}

export function renderAgentsOverlayBody(agents: AgentSnapshot[], width: number, maxHeight: number, theme: any): string[] {
	const rowBudget = Math.max(0, Math.min(OVERLAY_MAX_ROWS, maxHeight));
	if (rowBudget < OVERLAY_AGENT_ROWS || agents.length === 0) return [];
	const shownCount = Math.min(agents.length, Math.floor(rowBudget / OVERLAY_AGENT_ROWS));
	const lines = agents.slice(0, shownCount).flatMap((agent) => renderOverlayAgent(agent, width, theme));
	const hidden = agents.length - shownCount;
	if (hidden > 0 && lines.length < rowBudget) lines.push(theme.fg("dim", `… ${hidden} more · /agents`));
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
		name: agent.name,
		task: agent.task,
		contextMode: agent.contextMode,
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

function childTaskEntry(agent: ManagedAgent): TranscriptEntry {
	return {
		type: "message",
		message: { role: "user", content: agent.task, timestamp: agent.startedAt },
	};
}

function childTranscriptEntries(agent: ManagedAgent): TranscriptEntry[] {
	const session = SessionManager.open(agent.fork.sessionFile, agent.fork.directory, agent.cwd);
	const entries = session.getBranch().slice(agent.fork.initialEntryCount);
	const firstUser = entries.findIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	const taskEntry = childTaskEntry(agent);
	if (firstUser < 0) return [taskEntry, ...entries];
	entries[firstUser] = {
		...entries[firstUser],
		message: { ...entries[firstUser].message, content: agent.task },
	};
	return entries;
}

function formatAgent(agent: AgentSnapshot, includeOutput: boolean): string {
	const identity = agent.name ?? "unnamed agent";
	const lines = [`${statusSymbol(agent.status)} ${identity} · ${agent.contextMode} context · ${agent.status}`, `task: ${sanitizeTerminal(agent.task)}`];
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

function childTask(name: string, task: string, contextMode: ContextMode): string {
	const contextNote = contextMode === "fresh"
		? "No parent conversation was inherited; rely on the explicit task and available project instructions."
		: contextMode === "compacted"
			? "A compacted parent-conversation summary was inherited as context, not as a request to continue unrelated work."
			: "The forked parent conversation is context, not a request to continue unrelated work.";
	return `${CHILD_PROMPT}\n${contextNote}\n\nChild agent name: ${name}\n\nTask:\n${task.trim()}`;
}

function messageContent(agent: AgentSnapshot): string {
	return boundedText([
		`<subagent_result status="${agent.status}">`,
		`Agent: ${sanitizeTerminal(agent.name ?? "unnamed agent")}`,
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
	if (args.action === "send") return [compact(String(args.agent_name ?? ""), 48), compact(String(args.message ?? ""), 120)].filter(Boolean).join(" · ");
	if (args.action === "wait") {
		const names = Array.isArray(args.agent_names) && args.agent_names.length ? args.agent_names.join(", ") : "running agents";
		const timeout = Number.isInteger(args.timeout_ms)
			? (args.timeout_ms === 0 ? "no wait" : `${formatElapsed(args.timeout_ms as number)} timeout`)
			: "";
		return [compact(names, 120), timeout].filter(Boolean).join(" · ");
	}
	if (args.action === "list") return "current session";
	return compact(String(args.agent_name ?? ""), 80);
}

function reasoningDetail(args: Record<string, unknown> | undefined, theme: any, partial: boolean): string {
	const reasoning = compact(String(args?.reasoning ?? ""), 100);
	if (reasoning) return theme.fg("accent", reasoning);
	return partial ? theme.fg("dim", "…") : "";
}

function agentSummary(agent: AgentSnapshot, theme: any): string {
	const mark = theme.fg(statusColor(agent.status), statusSymbol(agent.status));
	const identity = theme.fg("text", theme.bold(agent.name ?? "unnamed agent"));
	const metadata = `${theme.fg("muted", `${agent.contextMode} context`)} · ${theme.fg(statusColor(agent.status), agent.status)}`;
	return `${mark} ${identity} · ${metadata}`;
}

type DetailLabel = "prompt" | "result" | "usage" | "error";

function detailPrefix(label: DetailLabel, theme: any, indent = TOOL_INDENT, failed = false): string {
	const labelColor = label === "prompt"
		? "muted"
		: label === "result"
			? (failed ? "error" : "success")
			: label === "error"
				? "error"
				: "muted";
	return `${indent}${theme.fg(labelColor, label.padEnd(6))}  `;
}

function detailLine(
	label: DetailLabel,
	content: string,
	width: number,
	theme: any,
	indent = TOOL_INDENT,
	failed = false,
): string {
	const contentColor = label === "prompt" || label === "usage" ? "dim" : label === "error" ? "error" : "text";
	const prefix = detailPrefix(label, theme, indent, failed);
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	return `${prefix}${theme.fg(contentColor, truncateToWidth(content, contentWidth, "…"))}`;
}

function expandedResultLines(agent: AgentSnapshot, width: number, theme: any): string[] {
	if (!agent.output) return [];
	const prefix = detailPrefix("result", theme, TOOL_INDENT, agent.status === "failed");
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const rendered = new Markdown(agent.output, 0, 0, getMarkdownTheme()).render(contentWidth);
	const continuation = " ".repeat(visibleWidth(prefix));
	return rendered.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function isSettled(agent: AgentSnapshot): boolean {
	return agent.status === "completed" || agent.status === "failed";
}

function agentBodyLines(
	agent: AgentSnapshot,
	width: number,
	theme: any,
	options: { prompt?: string; showResult?: boolean; showUsage?: boolean; expanded?: boolean } = {},
): string[] {
	const lines = [`${theme.fg("dim", TOOL_BRANCH)}${agentSummary(agent, theme)}`];
	if (options.prompt) lines.push(detailLine("prompt", compact(options.prompt, 240), width, theme));
	if (options.showResult && agent.output) {
		lines.push(...(options.expanded
			? expandedResultLines(agent, width, theme)
			: [detailLine("result", compact(agent.output, RESULT_PREVIEW_CHARS), width, theme, TOOL_INDENT, agent.status === "failed")]));
	}
	if (options.showResult && agent.error) lines.push(detailLine("error", compact(agent.error, 240), width, theme));
	const usage = options.showUsage ? usageText(agent) : "";
	if (usage) lines.push(detailLine("usage", usage, width, theme));
	return lines;
}

function resultText(result: any): string {
	return result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
}

function renderAgentCall(args: Record<string, unknown>, theme: any, context: ToolRenderContext) {
	if (!context?.isPartial) return new Container();
	const component = reuseAgentToolLines(context);
	component.update((width) => {
		const detail = actionDetail(args);
		return [
			toolHeadline(true, false, actionVerb(args.action, true), reasoningDetail(args, theme, true)),
			...(detail ? [args.action === "spawn"
				? detailLine("prompt", detail, width, theme, theme.fg("dim", TOOL_BRANCH))
				: `${TOOL_BRANCH}${theme.fg("text", detail)}`] : []),
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
		const alreadyReported = new Set(details?.alreadyReportedAgentIds ?? []);
		const visibleAgents = details?.agents?.filter((agent) => !alreadyReported.has(agent.id)) ?? [];
		if (action === "wait" && details?.agents?.length && visibleAgents.length === 0) return [];
		const lines = [toolHeadline(false, false, actionVerb(action, false, details), reasoningDetail(args, theme, false))];
		if (visibleAgents.length === 0) {
			lines.push(`${TOOL_BRANCH}${theme.fg("dim", action === "wait" ? "no running agents" : "no agents in this session")}`);
			return lines;
		}
		for (const agent of visibleAgents) {
			const completed = isSettled(agent);
			const prompt = action === "close"
				? undefined
				: action === "send"
					? compact(String(args?.message ?? ""), 240)
					: agent.task;
			const showsCompletion = (action === "wait" || action === "list") && completed;
			lines.push(...agentBodyLines(agent, width, theme, {
				prompt,
				showResult: showsCompletion,
				showUsage: showsCompletion,
				expanded: Boolean(options?.expanded),
			}));
		}
		return lines;
	});
	return component;
}

class CompletionComponent implements Component {
	private readonly component: AgentToolLines;
	constructor(agent: AgentSnapshot, expanded: boolean, theme: any) {
		this.component = new AgentToolLines((width) => [
			toolHeadline(false, agent.status === "failed", agent.status === "failed" ? "Agent failed" : "Agent completed", ""),
			...agentBodyLines(agent, width, theme, {
				prompt: agent.task,
				showResult: true,
				showUsage: true,
				expanded,
			}),
		]);
	}
	render(width: number): string[] { return this.component.render(width); }
	invalidate(): void { this.component.invalidate(); }
}

export default function registerSubagents(pi: ExtensionAPI, options: SubagentsOptions = {}) {
	if (isSubagentChild()) return;
	const agents = new Map<string, ManagedAgent>();
	const createClient = options.createClient ?? ((clientOptions: AgentClientOptions) => new RpcProcessClient(clientOptions));
	const forkContext = options.createContextFork ?? createContextFork;
	const summarizeContext = options.compactContext ?? compactContext;
	const registerCard = options.registerOverlayCard ?? registerOverlayCard;
	const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
	let generation = 0;
	let sessionActive = false;
	let spawnReservations = 0;
	let compactedSnapshot: { key: string; promise: Promise<string> } | undefined;
	let activeTranscriptRefresh: (() => void) | undefined;
	const usedAgentNames = new Set<string>();
	const reservedAgentNames = new Set<string>();

	const openAgents = () => [...agents.values()].filter((agent) => agent.client);
	const orderedAgents = () => [...agents.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt);
	const activeAgents = () => orderedAgents().filter((agent) => agent.client && isActive(agent));
	const overlayCard = registerCard({
		id: "subagents",
		order: 15,
		width: OVERLAY_WIDTH,
		minBodyHeight: OVERLAY_AGENT_ROWS,
		minTerminalWidth: 90,
		minTerminalHeight: 10,
		visible: () => activeAgents().length > 0,
		title: (theme) => `${theme.bold(" Agents ")}${theme.fg("accent", `● ${activeAgents().length} running`)} `,
		renderBody: (width, maxHeight, theme) => renderAgentsOverlayBody(activeAgents().map(snapshot), width, maxHeight, theme),
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
	const notifyCompletion = (agent: ManagedAgent) => {
		if (agent.suppressNotifications || agent.waiting > 0 || agent.completionDelivery !== "none" || agent.generation !== generation || agent.status === "closed") return;
		const data = snapshot(agent);
		agent.completionDelivery = "automatic";
		try {
			pi.sendMessage({
				customType: COMPLETION_MESSAGE_TYPE,
				content: messageContent(data),
				display: true,
				details: data,
			}, { deliverAs: "steer", triggerTurn: true });
		} catch {
			agent.completionDelivery = "none";
		}
	};
	const finishRun = (agent: ManagedAgent, status: "completed" | "failed", error?: string) => {
		if (agent.runSettled || agent.status === "closed") return;
		agent.runSettled = true;
		agent.status = status;
		agent.endedAt = Date.now();
		if (error) agent.error = boundedText(sanitizeTerminal(error), 4 * 1024);
		agent.resolveCompletion();
		updateOverlay();
		queueMicrotask(() => notifyCompletion(agent));
	};
	const handleEvent = (agent: ManagedAgent, event: RpcAgentEvent) => {
		if (agent.status === "closed") return;
		if (event.type === "agent_start") {
			agent.status = "running";
			updateOverlay();
			return;
		}
		if (event.type === "tool_execution_start") {
			const description = `${event.toolName ?? "tool"}${event.args?.command ? `: ${compact(event.args.command, 100)}` : ""}`;
			agent.activity.push(description);
			if (agent.activity.length > 12) agent.activity.shift();
			overlayCard.invalidate();
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			agent.output = boundedText(assistantText(event.message), RESULT_BYTES);
			agent.usage.turns += 1;
			const usage = event.message.usage;
			if (usage) {
				agent.usage.input += usage.input || 0;
				agent.usage.output += usage.output || 0;
				agent.usage.cacheRead += usage.cacheRead || 0;
				agent.usage.cacheWrite += usage.cacheWrite || 0;
				agent.usage.cost += usage.cost?.total || 0;
			}
			const persistedUsage = persistedSubagentUsage(event.message);
			if (persistedUsage && sessionActive && agent.generation === generation) {
				pi.appendEntry(SUBAGENT_USAGE_ENTRY_TYPE, persistedUsage);
				pi.events.emit(SUBAGENT_USAGE_EVENT, persistedUsage);
			}
			if (event.message.provider && event.message.model) agent.model = `${event.message.provider}/${event.message.model}`;
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				const error = event.message.errorMessage || `Agent ${event.message.stopReason}`;
				agent.error = boundedText(sanitizeTerminal(error), 4 * 1024);
			} else agent.error = undefined;
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
		agent.suppressNotifications ||= suppressNotification;
		if (agent.closePromise) return agent.closePromise;
		if (agent.status === "closed" && !agent.client && agent.cleanupComplete) return;
		agent.status = "closed";
		agent.endedAt ??= Date.now();
		if (!agent.runSettled) {
			agent.runSettled = true;
			agent.resolveCompletion();
		}
		updateOverlay();
		const client = agent.client;
		const operation = (async () => {
			try {
				await client?.stop();
				if (agent.client === client) agent.client = undefined;
				await agent.fork.cleanup();
				agent.cleanupComplete = true;
			} finally {
				updateOverlay();
				if (agent.cleanupComplete) trimClosed();
			}
		})();
		agent.closePromise = operation;
		try {
			await operation;
		} finally {
			if (agent.closePromise === operation) agent.closePromise = undefined;
		}
	};
	const startAgent = async (task: string, ctx: any, contextMode: ContextMode = "fresh", name?: string, signal?: AbortSignal): Promise<ManagedAgent> => {
		const normalizedTask = boundedInput(task, "spawn task", MAX_TASK_CHARS);
		const normalizedName = normalizeAgentName(name);
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
			const client = createClient({
				command: invocation.command,
				args: invocation.args,
				cwd: ctx.cwd,
				env: childEnvironment(id),
			});
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
				fork,
				completion: new Promise<void>((resolve) => { resolveCompletion = resolve; }),
				resolveCompletion,
				runSettled: false,
				waiting: 0,
				completionDelivery: "none",
				suppressNotifications: false,
				generation: reservation.generation,
				cleanupComplete: false,
			};
			agents.set(id, agent);
			reservation.commit();
			client.onEvent((event) => {
				handleEvent(agent!, event);
				activeTranscriptRefresh?.();
			});
			client.onExit((error) => {
				if (agent!.client === client) agent!.client = undefined;
				updateOverlay();
				void agent!.fork.cleanup().then(
					() => {
						agent!.cleanupComplete = true;
						if (isActive(agent!)) finishRun(agent!, "failed", error.message);
						else {
							if (agent!.status !== "closed") {
								agent!.status = "closed";
								agent!.endedAt ??= Date.now();
								updateOverlay();
							}
							trimClosed();
						}
					},
					(cleanupError) => {
						const message = `${error.message}; context cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
						if (isActive(agent!)) finishRun(agent!, "failed", message);
						else {
							agent!.status = "closed";
							agent!.error = boundedText(sanitizeTerminal(message), 4 * 1024);
							agent!.endedAt ??= Date.now();
							updateOverlay();
						}
					},
				);
			});
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
		description: "Spawn and coordinate uniquely named child agents with isolated persistent context. Actions: spawn starts one immediately; send continues it by name; wait collects one or more named results; list shows status; close stops and releases it. Children inherit the current model, tools, working directory, and project instructions. Conversation context can be fresh, compacted, or forked; fresh is the default. Completion results also arrive automatically.",
		promptSnippet: "Spawn and coordinate isolated child agents for explicitly delegated work",
		promptGuidelines: [
			"Use agents only when the user or applicable project instructions request delegation, subagents, or parallel agent work.",
			"Call agents with action=spawn for concrete independent tasks; give each child a concise task-specific name that is unique in the current session; multiple spawn calls can run concurrently, and the parent should continue useful non-overlapping work.",
			"Agents use fresh conversation context by default. Set context=compacted when prior decisions matter, or context=forked only when the exact parent conversation is required.",
			"Use agents action=wait only when blocked on child results; completed children report back automatically.",
			"After collecting a child's final result, call agents with action=close when no further follow-up is needed; completed children remain open and consume a process slot until closed.",
			"Give concurrently writing child agents disjoint file scopes to avoid conflicting edits.",
		],
		parameters: withReasoning({
			type: "object",
			properties: {
				action: { type: "string", enum: ["spawn", "send", "wait", "list", "close"], description: "Lifecycle action" },
				task: { type: "string", maxLength: MAX_TASK_CHARS, description: "Concrete task for spawn" },
				context: { type: "string", enum: ["fresh", "compacted", "forked"], description: "Conversation context for spawn (default fresh)" },
				name: { type: "string", maxLength: MAX_AGENT_NAME_CHARS, description: "Required unique human-readable name for spawn" },
				agent_name: { type: "string", description: "Agent name for send or close" },
				message: { type: "string", maxLength: MAX_MESSAGE_CHARS, description: "Follow-up instruction for send" },
				agent_names: { type: "array", items: { type: "string" }, description: "Agent names for wait; defaults to all running agents" },
				timeout_ms: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: `Wait timeout in milliseconds (default ${DEFAULT_WAIT_MS})` },
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
			if (params.action === "send") {
				const agent = resolveAgent(String(params.agent_name ?? ""));
				if (!agent) throw new Error(`Agent not found: ${params.agent_name ?? ""}`);
				if (!agent.client || agent.status === "closed") throw new Error(`Agent ${agent.name} is closed`);
				const message = boundedInput(params.message, "send message", MAX_MESSAGE_CHARS);
				const beginFollowUp = async () => {
					const client = agent.client;
					if (!client || agent.status === "closed") throw new Error(`Agent ${agent.name} is closed`);
					const previous = {
						status: agent.status,
						startedAt: agent.startedAt,
						endedAt: agent.endedAt,
						output: agent.output,
						error: agent.error,
						activity: agent.activity,
						completionDelivery: agent.completionDelivery,
						suppressNotifications: agent.suppressNotifications,
						completion: agent.completion,
						resolveCompletion: agent.resolveCompletion,
						runSettled: agent.runSettled,
					};
					agent.status = "running";
					agent.startedAt = Date.now();
					agent.endedAt = undefined;
					agent.output = "";
					agent.error = undefined;
					agent.activity = [`follow-up: ${compact(message, 100)}`];
					agent.completionDelivery = "none";
					agent.suppressNotifications = false;
					newCompletion(agent);
					const rejectedRunResolve = agent.resolveCompletion;
					updateOverlay();
					try {
						await client.prompt(message);
					} catch (error) {
						if (agent.client === client && isActive(agent) && !agent.runSettled) {
							Object.assign(agent, previous);
							rejectedRunResolve();
							updateOverlay();
						}
						throw error;
					}
				};
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
				updateOverlay();
				const data = snapshot(agent);
				return { content: [{ type: "text", text: `Sent follow-up to ${agent.name}.` }], details: { action: "send", agents: [data] } satisfies ToolDetails };
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
				const timeoutMs = params.timeout_ms ?? DEFAULT_WAIT_MS;
				if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new Error(`timeout_ms must be an integer between 0 and ${MAX_WAIT_MS}`);
				const waited = await waitForAgents(targets, timeoutMs, signal);
				const alreadyReportedAgentIds = targets
					.filter((agent) => agent.completionDelivery === "automatic")
					.map((agent) => agent.id);
				for (const agent of targets) {
					if (!isActive(agent) && agent.completionDelivery === "none") agent.completionDelivery = "wait";
				}
				const data = targets.map(snapshot);
				return {
					content: [{ type: "text", text: `${waited.interrupted ? "Wait interrupted.\n" : waited.timedOut ? "Wait timed out.\n" : ""}${formatAgents(data, true)}` }],
					details: { action: "wait", agents: data, alreadyReportedAgentIds, ...waited } satisfies ToolDetails,
				};
			}
			if (params.action === "list") {
				const data = orderedAgents().map(snapshot);
				return { content: [{ type: "text", text: formatAgents(data, false) }], details: { action: "list", agents: data } satisfies ToolDetails };
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
		description: "Select a child agent and open its live transcript",
		handler: async (_args, ctx) => {
			const ordered = orderedAgents();
			if (ordered.length === 0) {
				ctx.ui.notify("No subagents in this session.", "info");
				return;
			}
			const labels = ordered.map((agent) => `${statusSymbol(agent.status)} ${agent.name ?? agent.id} · ${agent.contextMode} context · ${agent.status} · ${compact(agent.task, 72)}`);
			const selected = await ctx.ui.select(`Subagents (${ordered.filter(isActive).length} running)`, labels);
			if (!selected) return;
			const agent = ordered[labels.indexOf(selected)];
			if (!agent) return;
			if (ctx.mode && ctx.mode !== "tui") {
				ctx.ui.notify(boundedText(formatAgent(snapshot(agent), true), 4 * 1024), agent.status === "failed" ? "error" : "info");
				return;
			}
			await showTranscript(agent, ctx);
		},
	});

	pi.on("session_start", () => {
		generation += 1;
		compactedSnapshot = undefined;
		sessionActive = true;
		updateOverlay();
	});
	pi.on("session_shutdown", async () => {
		sessionActive = false;
		generation += 1;
		compactedSnapshot = undefined;
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
