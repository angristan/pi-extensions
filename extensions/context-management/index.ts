import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { fitToolLine } from "../better-native-pi/core.js";
import { BOLD, GREEN, MAGENTA, RED, RESET } from "../better-native-pi/render.js";

const STATE_ENTRY = "context-management-state";
const NOTE_ENTRY = "context-management-note";
const ROLLOVER_ENTRY = "context-management-rollover";
const HANDOFF_MESSAGE = "context-management-handoff";
const REMINDER_MESSAGE = "context-management-reminder";
const RESET_SUMMARY_PREFIX = "[context-management:no-summary]\n";

export const REMINDER_PERCENT = 75;
export const ROLLOVER_PERCENT = 90;

const TOOL_NAMES = ["context_notes", "context_history", "get_context_remaining", "new_context"] as const;
const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);

interface StateEntryData {
	enabled?: boolean;
}

interface NoteEntryData {
	key?: string;
	content?: string;
	deleted?: boolean;
}

interface RolloverEntryData {
	id?: string;
	reason?: "automatic" | "tool" | "user" | "threshold";
}

export interface RestoredContextManagementState {
	enabled: boolean;
	notes: Map<string, string>;
	rolloverId?: string;
	reminded: boolean;
}

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => {
		if (part?.type === "text" && typeof part.text === "string") return part.text;
		if (part?.type === "thinking" && typeof part.thinking === "string") return part.thinking;
		if (part?.type === "toolCall") {
			const name = String(part.name ?? "tool");
			const args = part.arguments ?? part.args ?? part.input ?? {};
			return `[tool call: ${name}] ${JSON.stringify(args)}`;
		}
		if (part?.type === "image") return "[image]";
		return "";
	}).filter(Boolean).join("\n");
}

function compactLine(text: string, maxChars = 2_000): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function historyRows(entries: readonly any[], query: string, limit: number): Array<{ id: string; role: string; text: string }> {
	const needle = query.trim().toLowerCase();
	const matches: Array<{ id: string; role: string; text: string }> = [];
	for (const entry of entries) {
		if (entry?.type !== "message" || !entry.message) continue;
		const text = compactLine(messageText(entry.message));
		if (!text || (needle && !text.toLowerCase().includes(needle))) continue;
		const role = entry.message.role === "toolResult"
			? `tool:${entry.message.toolName ?? "unknown"}`
			: String(entry.message.role ?? "message");
		matches.push({ id: String(entry.id ?? "unknown"), role, text });
	}
	return matches.slice(-limit);
}

function noteKeyList(notes: ReadonlyMap<string, string>): string {
	const keys = [...notes.keys()].sort();
	if (keys.length === 0) return "No durable notes are saved.";
	const visible = keys.slice(0, 20);
	const suffix = keys.length > visible.length ? `, and ${keys.length - visible.length} more` : "";
	return `Durable note keys: ${visible.join(", ")}${suffix}.`;
}

function handoffText(notes: ReadonlyMap<string, string>): string {
	return [
		"A new context window has started without a summary of the earlier conversation.",
		"Continue the current task from durable notes and retrieve older transcript details only when needed.",
		noteKeyList(notes),
		"Use context_notes to read saved state and context_history to search the complete session transcript.",
	].join(" ");
}

function resetSummary(notes: ReadonlyMap<string, string>): string {
	return `${RESET_SUMMARY_PREFIX}${handoffText(notes)}`;
}

function isMatchingHandoff(message: any, rolloverId: string): boolean {
	return message?.role === "custom"
		&& message.customType === HANDOFF_MESSAGE
		&& message.details?.rolloverId === rolloverId;
}

function replacementHandoff(message: any): AgentMessage {
	return {
		role: "custom",
		customType: HANDOFF_MESSAGE,
		content: String(message.summary).slice(RESET_SUMMARY_PREFIX.length),
		display: false,
		details: { reason: "threshold" },
		timestamp: message.timestamp,
	} as AgentMessage;
}

/** Keep the transcript immutable while excluding everything before the latest rollover from provider requests. */
export function filterContextAfterRollover(messages: readonly AgentMessage[], rolloverId?: string): AgentMessage[] {
	if (!rolloverId) return [...messages];

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (isMatchingHandoff(messages[index], rolloverId)) return messages.slice(index);
	}

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as any;
		if (message?.role !== "compactionSummary" || typeof message.summary !== "string") continue;
		if (!message.summary.startsWith(RESET_SUMMARY_PREFIX)) continue;
		return [replacementHandoff(message), ...messages.slice(index + 1)];
	}

	// A marker can outlive its active branch context after a later native
	// compaction. If neither handoff form remains, Pi's active context is already
	// newer than the marker and must not be truncated again.
	return [...messages];
}

export function restoreContextManagementState(entries: readonly any[]): RestoredContextManagementState {
	let enabled = false;
	let rolloverId: string | undefined;
	let reminded = false;
	const notes = new Map<string, string>();

	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === STATE_ENTRY) {
			enabled = (entry.data as StateEntryData | undefined)?.enabled === true;
			continue;
		}
		if (entry?.type === "custom" && entry.customType === NOTE_ENTRY) {
			const data = entry.data as NoteEntryData | undefined;
			const key = data?.key?.trim();
			if (!key) continue;
			if (data.deleted) notes.delete(key);
			else if (typeof data.content === "string") notes.set(key, data.content);
			continue;
		}
		if (entry?.type === "custom" && entry.customType === ROLLOVER_ENTRY) {
			const id = (entry.data as RolloverEntryData | undefined)?.id;
			if (typeof id === "string" && id) {
				rolloverId = id;
				reminded = false;
			}
			continue;
		}
		if (entry?.type === "custom_message" && entry.customType === REMINDER_MESSAGE) reminded = true;
	}

	return { enabled, notes, rolloverId, reminded };
}

// ============================================================================
// Tool rendering
// ============================================================================

const TOOL_BRANCH = "  └ ";
const TOOL_INDENT = "    ";

type ContextToolKind = "notes" | "history" | "remaining" | "rollover";

interface ContextToolRenderContext {
	lastComponent?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	args?: Record<string, unknown>;
}

interface ContextToolRenderOptions {
	isPartial?: boolean;
	expanded?: boolean;
}

interface RenderedToolState {
	headline: string;
	branch?: string;
	expandedText?: string;
	error?: boolean;
}

class ContextToolLines implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private source: (width: number) => string[] = () => []) {}

	update(source: (width: number) => string[]): void {
		this.source = source;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === max) return this.cachedLines;
		this.cachedLines = this.source(max).flatMap((line) =>
			visibleWidth(line) <= max ? [line] : [fitToolLine(line, max)]);
		this.cachedWidth = max;
		return this.cachedLines;
	}
}

function contextToolLines(context: ContextToolRenderContext): ContextToolLines {
	return context.lastComponent instanceof ContextToolLines ? context.lastComponent : new ContextToolLines();
}

function sanitizeRenderedText(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|\x07)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function oneLine(value: unknown): string {
	return sanitizeRenderedText(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
}

function toolResultText(result: any): string {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item: any) => item?.type === "text" && typeof item.text === "string")
		.map((item: any) => item.text)
		.join("\n")
		.trim();
}

function toolHeadline(partial: boolean, error: boolean, text: string): string {
	const mark = partial ? `${MAGENTA}•${RESET}` : error ? `${RED}•${RESET}` : `${GREEN}•${RESET}`;
	return `${mark} ${BOLD}${text}${RESET}`;
}

function expandedRows(text: string, width: number, theme: any): string[] {
	const cleaned = sanitizeRenderedText(text).replace(/\s+$/g, "");
	if (!cleaned) return [];
	const available = Math.max(1, width - visibleWidth(TOOL_INDENT));
	return cleaned.split("\n").flatMap((line) =>
		wrapTextWithAnsi(theme.fg("dim", line || " "), available).map((row) => `${TOOL_INDENT}${row}`));
}

function formatCount(value: unknown): string {
	const count = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}K`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function callState(kind: ContextToolKind, args: Record<string, unknown>): RenderedToolState {
	if (kind === "notes") {
		const action = typeof args.action === "string" ? args.action : "list";
		const key = oneLine(args.key);
		const preview = oneLine(args.content);
		const headline = action === "read"
			? "Reading context note"
			: action === "write"
				? "Saving context note"
				: action === "delete"
					? "Deleting context note"
					: "Listing context notes";
		return { headline, branch: [key, preview].filter(Boolean).join(" · ") || undefined };
	}
	if (kind === "history") {
		const query = oneLine(args.query);
		const limit = typeof args.limit === "number" ? `last ${args.limit}` : "";
		return {
			headline: query ? "Searching context history" : "Reading recent context history",
			branch: [query, limit].filter(Boolean).join(" · ") || undefined,
		};
	}
	if (kind === "remaining") return { headline: "Checking context remaining" };
	return { headline: "Starting new context", branch: oneLine(args.reason) || undefined };
}

function failureState(kind: ContextToolKind, text: string): RenderedToolState {
	const label = kind === "notes"
		? "Context note failed"
		: kind === "history"
			? "Context history failed"
			: kind === "remaining"
				? "Context check failed"
				: "Context rollover failed";
	return { headline: label, branch: oneLine(text) || "Unknown error", expandedText: text, error: true };
}

function resultState(
	kind: ContextToolKind,
	result: any,
	context: ContextToolRenderContext,
): RenderedToolState {
	const details = result?.details ?? {};
	const text = toolResultText(result);
	if (context.isError || details.enabled === false || details.ok === false) return failureState(kind, text);

	if (kind === "notes") {
		const action = typeof context.args?.action === "string" ? context.args.action : "list";
		const key = oneLine(details.key ?? context.args?.key);
		if (action === "list") {
			const keys = Array.isArray(details.keys) ? details.keys.map(oneLine).filter(Boolean) : [];
			return {
				headline: keys.length ? `Listed ${keys.length} context note${keys.length === 1 ? "" : "s"}` : "No context notes saved",
				branch: keys.join(", ") || undefined,
			};
		}
		if (action === "read" && details.found === false) {
			return { headline: "Context note not found", branch: key || oneLine(text), error: true };
		}
		if (action === "read") {
			return { headline: "Read context note", branch: [key, oneLine(text)].filter(Boolean).join(" · "), expandedText: text };
		}
		if (action === "delete") return { headline: "Deleted context note", branch: key || undefined };
		const content = typeof context.args?.content === "string" ? context.args.content : "";
		return { headline: "Saved context note", branch: [key, oneLine(content)].filter(Boolean).join(" · "), expandedText: content };
	}

	if (kind === "history") {
		const matches = typeof details.matches === "number" ? Math.max(0, details.matches) : 0;
		return {
			headline: matches ? `Found ${matches} history match${matches === 1 ? "" : "es"}` : "No matching context history",
			branch: matches ? oneLine(text.split("\n")[0]) : undefined,
			expandedText: matches ? text : undefined,
		};
	}

	if (kind === "remaining") {
		if (details.known === false) return { headline: "Context usage unavailable", branch: oneLine(text) || undefined };
		const percent = typeof details.percent === "number" ? `${details.percent.toFixed(1)}% used` : undefined;
		const remaining = typeof details.remaining === "number" ? `${formatCount(details.remaining)} tokens remain` : undefined;
		return { headline: "Checked context remaining", branch: [percent, remaining].filter(Boolean).join(" · ") || oneLine(text) };
	}

	return {
		headline: "Started new context",
		branch: [oneLine(context.args?.reason), "without conversation summary"].filter(Boolean).join(" · "),
	};
}

function renderContextToolCall(
	kind: ContextToolKind,
	args: Record<string, unknown>,
	theme: any,
	context: ContextToolRenderContext,
): Component {
	if (!context.isPartial) return new Container();
	const component = contextToolLines(context);
	const state = callState(kind, args ?? {});
	component.update(() => [
		toolHeadline(true, false, state.headline),
		...(state.branch ? [`${TOOL_BRANCH}${theme.fg("dim", state.branch)}`] : []),
	]);
	return component;
}

function renderContextToolResult(
	kind: ContextToolKind,
	result: any,
	options: ContextToolRenderOptions,
	theme: any,
	context: ContextToolRenderContext,
): Component {
	if (options.isPartial) return new Container();
	const component = contextToolLines(context);
	const state = resultState(kind, result, context);
	component.update((width) => [
		toolHeadline(false, Boolean(state.error), state.headline),
		...(state.branch ? [`${TOOL_BRANCH}${theme.fg(state.error ? "error" : "dim", state.branch)}`] : []),
		...(options.expanded && state.expandedText ? expandedRows(state.expandedText, width, theme) : []),
	]);
	return component;
}

function inactiveResult() {
	return textResult("Context management is disabled for this session. Enable it with /context-management on.", {
		enabled: false,
	});
}

export default function contextManagement(pi: ExtensionAPI) {
	let enabled = false;
	let notes = new Map<string, string>();
	let rolloverId: string | undefined;
	let reminded = false;
	let rolloverPending = false;

	const syncTools = () => {
		const active = pi.getActiveTools();
		const activeSet = new Set(active);
		if (enabled) {
			const added = TOOL_NAMES.filter((name) => !activeSet.has(name));
			if (added.length) pi.setActiveTools([...active, ...added]);
			return;
		}
		const withoutContextTools = active.filter((name) => !TOOL_NAME_SET.has(name));
		if (withoutContextTools.length !== active.length) pi.setActiveTools(withoutContextTools);
	};

	const updateStatus = (ctx: any) => {
		ctx.ui.setStatus("context-management", enabled ? "ctx:auto" : undefined);
	};

	const restore = (ctx: any) => {
		const restored = restoreContextManagementState(ctx.sessionManager.getBranch());
		enabled = restored.enabled;
		notes = restored.notes;
		rolloverId = restored.rolloverId;
		reminded = restored.reminded;
		rolloverPending = false;
		syncTools();
		updateStatus(ctx);
	};

	const persistEnabled = (value: boolean) => {
		enabled = value;
		pi.appendEntry(STATE_ENTRY, { enabled: value } satisfies StateEntryData);
		syncTools();
	};

	const startRollover = (reason: RolloverEntryData["reason"]) => {
		const id = randomUUID();
		rolloverId = id;
		reminded = false;
		rolloverPending = true;
		pi.appendEntry(ROLLOVER_ENTRY, { id, reason } satisfies RolloverEntryData);
		pi.sendMessage({
			customType: HANDOFF_MESSAGE,
			content: handoffText(notes),
			display: false,
			details: { rolloverId: id, reason },
		}, { triggerTurn: false });
		return id;
	};

	pi.registerCommand("context-management", {
		description: "Enable, disable, inspect, or reset session context management",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				const usage = ctx.getContextUsage();
				const usageText = usage?.percent == null ? "usage unknown" : `${usage.percent.toFixed(1)}% used`;
				ctx.ui.notify(`Context management is ${enabled ? "on" : "off"}; ${usageText}; ${notes.size} durable note${notes.size === 1 ? "" : "s"}.`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				persistEnabled(action === "on");
				updateStatus(ctx);
				ctx.ui.notify(`Context management ${enabled ? "enabled" : "disabled"} for this session.`, "info");
				return;
			}
			if (action === "reset") {
				if (!enabled) {
					ctx.ui.notify("Enable context management before resetting context.", "warning");
					return;
				}
				startRollover("user");
				ctx.ui.notify("The next model request will use a fresh context window.", "info");
				return;
			}
			ctx.ui.notify("Usage: /context-management on|off|status|reset", "warning");
		},
	});

	pi.registerTool({
		name: "context_notes",
		label: "Context notes",
		description: "Read or update durable notes that survive context rollover in this session.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("write"), Type.Literal("delete")]),
			key: Type.Optional(Type.String({ description: "Stable note key", maxLength: 80 })),
			content: Type.Optional(Type.String({ description: "Complete replacement content for a written note", maxLength: 20_000 })),
		}),
		renderShell: "self",
		renderCall: (args, theme, context) => renderContextToolCall("notes", args, theme, context),
		renderResult: (result, options, theme, context) => renderContextToolResult("notes", result, options, theme, context),
		async execute(_toolCallId, params) {
			if (!enabled) return inactiveResult();
			if (params.action === "list") return textResult(noteKeyList(notes), { keys: [...notes.keys()].sort() });
			const key = params.key?.trim();
			if (!key) return textResult(`A key is required for ${params.action}.`, { ok: false });
			if (params.action === "read") {
				const content = notes.get(key);
				return content === undefined
					? textResult(`No durable note named ${key}.`, { found: false, key })
					: textResult(content, { found: true, key });
			}
			if (params.action === "delete") {
				notes.delete(key);
				pi.appendEntry(NOTE_ENTRY, { key, deleted: true } satisfies NoteEntryData);
				return textResult(`Deleted durable note ${key}.`, { deleted: true, key });
			}
			if (typeof params.content !== "string" || !params.content.trim()) {
				return textResult("Non-empty content is required when writing a note.", { ok: false, key });
			}
			notes.set(key, params.content);
			pi.appendEntry(NOTE_ENTRY, { key, content: params.content } satisfies NoteEntryData);
			return textResult(`Saved durable note ${key}.`, { saved: true, key });
		},
	});

	pi.registerTool({
		name: "context_history",
		label: "Context history",
		description: "Search messages in the complete session branch, including transcript content hidden by context rollover.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case-insensitive text query; omit for recent messages", maxLength: 500 })),
			limit: Type.Optional(Type.Integer({ description: "Maximum matches", minimum: 1, maximum: 20 })),
		}),
		renderShell: "self",
		renderCall: (args, theme, context) => renderContextToolCall("history", args, theme, context),
		renderResult: (result, options, theme, context) => renderContextToolResult("history", result, options, theme, context),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!enabled) return inactiveResult();
			const rows = historyRows(ctx.sessionManager.getBranch(), params.query ?? "", params.limit ?? 8);
			if (!rows.length) return textResult("No matching session history.", { matches: 0 });
			const output = rows.map((row) => `[${row.id} ${row.role}] ${row.text}`).join("\n\n");
			return textResult(output.slice(0, 16_000), { matches: rows.length });
		},
	});

	pi.registerTool({
		name: "get_context_remaining",
		label: "Context remaining",
		description: "Report the current model context usage and remaining token estimate.",
		parameters: Type.Object({}),
		renderShell: "self",
		renderCall: (args, theme, context) => renderContextToolCall("remaining", args, theme, context),
		renderResult: (result, options, theme, context) => renderContextToolResult("remaining", result, options, theme, context),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!enabled) return inactiveResult();
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens == null || usage.percent == null) {
				return textResult("Context usage is unknown until the model completes another response.", { known: false });
			}
			const remaining = Math.max(0, usage.contextWindow - usage.tokens);
			return textResult(`${usage.tokens} / ${usage.contextWindow} tokens used (${usage.percent.toFixed(1)}%); approximately ${remaining} tokens remain.`, {
				known: true,
				tokens: usage.tokens,
				contextWindow: usage.contextWindow,
				percent: usage.percent,
				remaining,
			});
		},
	});

	pi.registerTool({
		name: "new_context",
		label: "New context",
		description: "Start a fresh model context without summarizing prior conversation. Save durable notes first.",
		promptGuidelines: [
			"When context management is active, use context_notes for durable task state, check get_context_remaining during long tasks, and call new_context before the window is exhausted.",
		],
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Short reason for the rollover", maxLength: 200 })),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: (args, theme, context) => renderContextToolCall("rollover", args, theme, context),
		renderResult: (result, options, theme, context) => renderContextToolResult("rollover", result, options, theme, context),
		async execute() {
			if (!enabled) return inactiveResult();
			if (!rolloverPending) startRollover("tool");
			return textResult("A new context window will start without summarizing conversation history.", {
				rolloverId,
			});
		},
	});

	pi.on("context", (event) => {
		const filtered = filterContextAfterRollover(event.messages, rolloverId);
		if (rolloverId && filtered.some((message) => isMatchingHandoff(message, rolloverId))) rolloverPending = false;
		return { messages: filtered };
	});

	pi.on("turn_end", (_event, ctx) => {
		if (!enabled || rolloverPending) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent == null) return;
		if (usage.percent >= ROLLOVER_PERCENT) {
			startRollover("automatic");
			return;
		}
		if (usage.percent < REMINDER_PERCENT || reminded) return;
		reminded = true;
		pi.sendMessage({
			customType: REMINDER_MESSAGE,
			content: `Context is ${usage.percent.toFixed(1)}% full. Update durable context_notes now and prepare to call new_context before important task state is lost.`,
			display: false,
			details: { percent: usage.percent },
		}, { triggerTurn: false });
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!enabled || event.reason !== "threshold") return;

		const lastContextEntry = [...event.branchEntries].reverse().find((entry: any) =>
			entry?.type === "message" || entry?.type === "custom_message",
		) as any;
		const pendingUserEntryId = lastContextEntry?.type === "message" && lastContextEntry.message?.role === "user"
			? String(lastContextEntry.id)
			: undefined;
		const id = randomUUID();
		pi.appendEntry(ROLLOVER_ENTRY, { id, reason: "threshold" } satisfies RolloverEntryData);
		rolloverId = id;
		reminded = false;
		rolloverPending = false;
		const markerEntryId = ctx.sessionManager.getLeafId();

		return {
			compaction: {
				summary: resetSummary(notes),
				firstKeptEntryId: pendingUserEntryId ?? markerEntryId ?? event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { contextManagement: true, noSummary: true, rolloverId: id },
			},
		};
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("context-management", undefined));
}
