import { getMarkdownTheme, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed } from "../better-native-pi/core.js";
import { BOLD, GREEN, MAGENTA, RED, RESET } from "../better-native-pi/render.js";
import type { TranscriptEntry } from "../transcript/pager.js";
import type { ContextFork } from "./context.js";
import type { AgentMailboxEvent, MailboxSnapshot } from "./mailbox.js";
import { RESULT_BYTES, boundedText, compact, isActive, sanitizeTerminal, type AgentSnapshot } from "./lifecycle.js";

export const COMPLETION_MESSAGE_TYPE = "subagent-result";
export const MAILBOX_MESSAGE_TYPE = "subagent-message";
export const MAILBOX_BATCH_TYPE = "subagent-mailbox";
export const MAILBOX_HISTORY_ENTRY_TYPE = "subagent-mailbox-history";

const TOOL_OUTPUT_BYTES = 48 * 1024;
const MAX_REPORT_CHARS = 4_000;
const RESULT_PREVIEW_CHARS = 180;
const TOOL_BRANCH = "  └ ";
const TOOL_INDENT = "    ";
const OVERLAY_MAX_ROWS = 10;
const OVERLAY_AGENT_ROWS = 3;

export interface ToolDetails {
	action: string;
	agents: AgentSnapshot[];
	mailbox?: AgentMailboxEvent[];
	alreadyReportedAgentIds?: string[];
	timedOut?: boolean;
	interrupted?: boolean;
}

function tokenText(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.round(count / 1_000)}k`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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

export function statusSymbol(status: AgentSnapshot["status"]): string {
	if (status === "starting" || status === "running") return "●";
	if (status === "completed") return "✓";
	if (status === "failed") return "×";
	if (status === "interrupted") return "↯";
	return "■";
}

function statusColor(status: AgentSnapshot["status"]): string {
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

export function renderAgentsOverlayBody(
	agents: AgentSnapshot[],
	width: number,
	maxHeight: number,
	theme: any,
	mailbox?: MailboxSnapshot,
): string[] {
	const rowBudget = Math.max(0, Math.min(OVERLAY_MAX_ROWS, maxHeight));
	const unread = mailbox?.unread ?? 0;
	if (rowBudget === 0 || (agents.length === 0 && unread === 0)) return [];
	const lines: string[] = [];
	if (unread > 0) {
		lines.push(theme.fg("accent", `✉ ${unread} unread · ${formatBytes(mailbox?.messageBytes ?? 0)} progress · /agents`));
	}
	const agentBudget = Math.max(0, rowBudget - lines.length);
	const shownCount = Math.min(agents.length, Math.floor(agentBudget / OVERLAY_AGENT_ROWS));
	lines.push(...agents.slice(0, shownCount).flatMap((agent) => renderOverlayAgent(agent, width, theme)));
	const hidden = agents.length - shownCount;
	if (hidden > 0 && lines.length < rowBudget) lines.push(theme.fg("dim", `… ${hidden} more · /agents`));
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

export function mailboxStatus(snapshot: MailboxSnapshot): string {
	const metrics = snapshot.metrics;
	return [
		`${snapshot.unread} unread`,
		`${formatBytes(snapshot.messageBytes)} progress`,
		`${metrics.published} published`,
		`${metrics.delivered} delivered`,
		`${metrics.consumed} consumed`,
		`${metrics.coalesced} coalesced`,
		`${metrics.dropped} dropped`,
		`${metrics.recovered} recovered`,
	].join(" · ");
}

export function childTaskEntry(agent: AgentSnapshot): TranscriptEntry {
	return {
		type: "message",
		transcriptLabel: "Task",
		message: { role: "user", content: agent.task, timestamp: agent.startedAt },
	};
}

type TranscriptAgent = AgentSnapshot & { fork: ContextFork };

export function childTranscriptEntries(agent: TranscriptAgent): TranscriptEntry[] {
	const session = SessionManager.open(agent.fork.sessionFile, agent.fork.directory, agent.cwd);
	const entries = session.getBranch().slice(agent.fork.initialEntryCount);
	const firstUser = entries.findIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	const taskEntry = childTaskEntry(agent);
	if (firstUser < 0) return [taskEntry, ...entries];
	entries[firstUser] = {
		...entries[firstUser],
		transcriptLabel: "Task",
		message: { ...entries[firstUser].message, content: agent.task },
	};
	return entries;
}

export function formatAgent(agent: AgentSnapshot, includeOutput: boolean): string {
	const identity = agent.name ?? "unnamed agent";
	const lines = [`${statusSymbol(agent.status)} ${identity} · ${agent.contextMode} context · ${agent.status}`, `task: ${sanitizeTerminal(agent.task)}`];
	if (agent.error) lines.push(`error: ${agent.error}`);
	const usage = usageText(agent);
	if (usage) lines.push(`usage: ${usage}`);
	if (includeOutput && agent.output) lines.push("", "result:", agent.output);
	else if (includeOutput && isActive(agent)) lines.push("", "(still running)");
	return lines.join("\n");
}

export function formatAgents(agents: AgentSnapshot[], includeOutput: boolean): string {
	if (agents.length === 0) return "No subagents in this session.";
	return boundedText(agents.map((agent) => formatAgent(agent, includeOutput)).join("\n\n---\n\n"), TOOL_OUTPUT_BYTES);
}

export function messageContent(agent: AgentSnapshot): string {
	return boundedText([
		`<subagent_result status="${agent.status}">`,
		`Agent: ${sanitizeTerminal(agent.name ?? "unnamed agent")}`,
		`Task: ${sanitizeTerminal(agent.task)}`,
		agent.error ? `Error: ${agent.error}` : "",
		agent.output ? `Result:\n${agent.output}` : "Result: (no final text)",
		"</subagent_result>",
	].filter(Boolean).join("\n\n"), RESULT_BYTES);
}

export function mailboxMessageContent(event: AgentMailboxEvent): string {
	return boundedText([
		"<subagent_message>",
		`Agent: ${sanitizeTerminal(event.agentName)}`,
		event.omittedBefore ? `Earlier updates omitted: ${event.omittedBefore}` : "",
		`Message:\n${sanitizeTerminal(event.content)}`,
		"</subagent_message>",
	].filter(Boolean).join("\n\n"), MAX_REPORT_CHARS + 256);
}

export function formatMailboxEvents(events: AgentMailboxEvent[]): string {
	const messages = events.filter((event) => event.kind === "message");
	if (messages.length === 0) return "";
	return boundedText(messages.map(mailboxMessageContent).join("\n\n---\n\n"), TOOL_OUTPUT_BYTES);
}

export function mailboxBatchContent(events: AgentMailboxEvent[], agents: AgentSnapshot[]): string {
	const omissions = events
		.filter((event) => event.omittedBefore && event.kind === "final")
		.map((event) => `Earlier updates omitted for ${sanitizeTerminal(event.agentName)}: ${event.omittedBefore}`)
		.join("\n");
	return boundedText([
		omissions,
		formatMailboxEvents(events),
		agents.length > 0 ? formatAgents(agents, true) : "",
	].filter(Boolean).join("\n\n"), TOOL_OUTPUT_BYTES);
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
	if (action === "send" || action === "followup") return partial ? "Sending follow-up" : "Sent follow-up";
	if (action === "message") return partial ? "Queueing agent message" : "Queued agent message";
	if (action === "wait") {
		if (!partial && details?.interrupted) return "Wait interrupted";
		if (!partial && details?.timedOut) return "Wait interval ended";
		return partial ? "Waiting for agents" : "Waited for agents";
	}
	if (action === "list") return partial ? "Listing agents" : "Listed agents";
	if (action === "read") return partial ? "Reading agent" : "Read agent";
	if (action === "interrupt") return partial ? "Interrupting agent" : "Interrupted agent";
	if (action === "close") return partial ? "Closing agent" : "Closed agent";
	return partial ? "Using agents" : "Used agents";
}

function actionDetail(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	if (args.action === "spawn") return compact(String(args.task ?? ""), 180);
	if (args.action === "send" || args.action === "followup" || args.action === "message") return [compact(String(args.agent_name ?? ""), 48), compact(String(args.message ?? ""), 120)].filter(Boolean).join(" · ");
	if (args.action === "wait") {
		const names = Array.isArray(args.agent_names) && args.agent_names.length ? args.agent_names.join(", ") : "running agents";
		const returnWhen = args.return_when === "any" ? "first mailbox update" : args.return_when === "all" ? "all completions" : "";
		const wakeOn = args.wake_on === "final" ? "final only" : "";
		const timeout = Number.isInteger(args.timeout_ms)
			? (args.timeout_ms === 0 ? "no wait" : `${formatElapsed(args.timeout_ms as number)} timeout`)
			: "";
		return [compact(names, 120), returnWhen, wakeOn, timeout].filter(Boolean).join(" · ");
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

type DetailLabel = "prompt" | "message" | "result" | "usage" | "error";

function detailPrefix(label: DetailLabel, theme: any, indent = TOOL_INDENT, failed = false): string {
	const labelColor = label === "prompt"
		? "muted"
		: label === "message"
			? "accent"
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
	return agent.status === "completed" || agent.status === "failed" || agent.status === "interrupted";
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

function mailboxEventLines(event: AgentMailboxEvent, width: number, theme: any): string[] {
	const omission = event.omittedBefore ? ` · ${event.omittedBefore} earlier omitted` : "";
	return [
		`${theme.fg("dim", TOOL_BRANCH)}${theme.fg("accent", "↳")} ${theme.fg("text", theme.bold(event.agentName))} · ${theme.fg("muted", `message${omission}`)}`,
		detailLine("message", compact(event.content, 240), width, theme),
	];
}

function resultText(result: any): string {
	return result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "";
}

export function renderAgentCall(args: Record<string, unknown>, theme: any, context: ToolRenderContext) {
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

export function renderAgentResult(result: any, options: ToolRenderOptions, theme: any, context: ToolRenderContext) {
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
		const mailboxMessages = details?.mailbox?.filter((event) => event.kind === "message") ?? [];
		if (action === "wait" && details?.agents?.length && visibleAgents.length === 0 && mailboxMessages.length === 0) return [];
		const lines = [toolHeadline(false, false, actionVerb(action, false, details), reasoningDetail(args, theme, false))];
		for (const event of mailboxMessages) lines.push(...mailboxEventLines(event, width, theme));
		if (visibleAgents.length === 0) {
			if (mailboxMessages.length === 0) lines.push(`${TOOL_BRANCH}${theme.fg("dim", action === "wait" ? "no running agents" : "no agents in this session")}`);
			return lines;
		}
		for (const agent of visibleAgents) {
			const completed = isSettled(agent);
			const prompt = action === "close"
				? undefined
				: action === "send" || action === "followup" || action === "message"
					? compact(String(args?.message ?? ""), 240)
					: agent.task;
			const showsCompletion = (action === "wait" || action === "list" || action === "read") && completed;
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

class MailboxMessageComponent implements Component {
	private readonly component: AgentToolLines;
	constructor(event: AgentMailboxEvent, theme: any) {
		this.component = new AgentToolLines((width) => [
			toolHeadline(false, false, "Agent message", ""),
			...mailboxEventLines(event, width, theme),
		]);
	}
	render(width: number): string[] { return this.component.render(width); }
	invalidate(): void { this.component.invalidate(); }
}

class MailboxBatchComponent implements Component {
	private readonly component: AgentToolLines;
	constructor(details: ToolDetails, expanded: boolean, theme: any) {
		this.component = new AgentToolLines((width) => {
			const lines = [toolHeadline(false, false, "Agent mailbox", "")];
			for (const event of details.mailbox?.filter((candidate) => candidate.kind === "message") ?? []) {
				lines.push(...mailboxEventLines(event, width, theme));
			}
			for (const event of details.mailbox?.filter((candidate) => candidate.kind === "final" && candidate.omittedBefore) ?? []) {
				lines.push(`${TOOL_BRANCH}${theme.fg("muted", `${event.agentName} · ${event.omittedBefore} earlier updates omitted`)}`);
			}
			for (const agent of details.agents) {
				lines.push(...agentBodyLines(agent, width, theme, {
					prompt: agent.task,
					showResult: true,
					showUsage: true,
					expanded,
				}));
			}
			return lines;
		});
	}
	render(width: number): string[] { return this.component.render(width); }
	invalidate(): void { this.component.invalidate(); }
}

export function registerSubagentRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message: any, options: any, theme: any) => {
		const data = message.details as AgentSnapshot | undefined;
		return data ? new CompletionComponent(data, Boolean(options.expanded), theme) : new Text(String(message.content ?? ""), 0, 0);
	});
	pi.registerMessageRenderer(MAILBOX_MESSAGE_TYPE, (message: any, _options: any, theme: any) => {
		const data = message.details as AgentMailboxEvent | undefined;
		return data ? new MailboxMessageComponent(data, theme) : new Text(String(message.content ?? ""), 0, 0);
	});
	pi.registerMessageRenderer(MAILBOX_BATCH_TYPE, (message: any, options: any, theme: any) => {
		const data = message.details as ToolDetails | undefined;
		return data ? new MailboxBatchComponent(data, Boolean(options.expanded), theme) : new Text(String(message.content ?? ""), 0, 0);
	});
	pi.registerEntryRenderer(MAILBOX_HISTORY_ENTRY_TYPE, (entry: any, options: any, theme: any) => {
		const data = entry.data?.details as ToolDetails | undefined;
		return data ? new MailboxBatchComponent(data, Boolean(options.expanded), theme) : new Text("Agent mailbox update", 0, 0);
	});
}
