/**
 * Dependency graph:
 * Direct: `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`,
 *   `@earendil-works/pi-tui`.
 * Used by: `Pi extension loader`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";

const MAX_LARGEST_ENTRIES = 12;

export interface ContextCategory {
	id: string;
	label: string;
	tokens: number;
	entries: number;
}

export interface LargestContextEntry {
	id: string;
	label: string;
	tokens: number;
	path?: string;
}

export interface ContextAnalysis {
	systemTokens: number;
	activeTranscriptTokens: number;
	categories: ContextCategory[];
	compactedAwayTokens: number;
	compactedAwayEntries: number;
	inactiveTreeTokens: number;
	inactiveTreeEntries: number;
	customHiddenEntries: number;
	providerTokens?: number | null;
	contextWindow?: number;
	latestCacheRead: number;
	latestCacheWrite: number;
	latestPromptInput: number;
	largest: LargestContextEntry[];
	contextFiles: string[];
	skills: string[];
	activeTools: string[];
}

function estimateTextTokens(text: string): number {
	return text ? Math.ceil(text.length / 4) : 0;
}

function compactNumber(value: number): string {
	const safe = Math.max(0, Math.round(value));
	if (safe < 1_000) return String(safe);
	if (safe < 1_000_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}K`;
	if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(safe < 10_000_000 ? 1 : 0)}M`;
	return `${(safe / 1_000_000_000).toFixed(1)}B`;
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}

export function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|\x07)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function contentParts(message: any): any[] {
	if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
	return Array.isArray(message?.content) ? message.content : [];
}

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part?.text === "string") return part.text;
		if (typeof part?.thinking === "string") return part.thinking;
		if (part?.type === "toolCall") return `${part.name ?? "tool"} ${stringify(part.arguments ?? {})}`;
		if (part?.type === "image") return "[image]";
		return "";
	}).filter(Boolean).join("\n");
}

function entryText(entry: any): string {
	if (entry.type === "message") {
		const message = entry.message ?? {};
		const prefix = message.role === "toolResult"
			? `${message.toolName ?? "tool"} result\n`
			: `${message.role ?? "message"}\n`;
		return `${prefix}${contentText(message.content)}`;
	}
	if (entry.type === "compaction") return `Compaction summary\n${entry.summary ?? ""}`;
	if (entry.type === "branch_summary") return `Branch summary\n${entry.summary ?? ""}`;
	if (entry.type === "custom_message") return `Custom message ${entry.customType ?? ""}\n${contentText(entry.content)}`;
	return stringify(entry);
}

function entryParticipatesInContext(entry: any): boolean {
	return entry.type === "message"
		|| entry.type === "compaction"
		|| entry.type === "branch_summary"
		|| entry.type === "custom_message";
}

function estimateEntryTokens(entry: any): number {
	if (entry.type === "message") {
		try { return estimateTokens(entry.message as AgentMessage); } catch { return estimateTextTokens(entryText(entry)); }
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") return estimateTextTokens(entry.summary ?? "");
	if (entry.type === "custom_message") return estimateTextTokens(contentText(entry.content));
	return 0;
}

function toolPath(part: any): string | undefined {
	const args = part?.arguments;
	if (!args || typeof args !== "object") return undefined;
	for (const key of ["path", "file_path", "cwd"]) {
		if (typeof args[key] === "string") return args[key];
	}
	return undefined;
}

function entryLabel(entry: any): { label: string; path?: string } {
	if (entry.type === "compaction") return { label: "compaction summary" };
	if (entry.type === "branch_summary") return { label: "branch summary" };
	if (entry.type === "custom_message") return { label: `${entry.display ? "visible" : "hidden"} custom message: ${entry.customType ?? "unknown"}` };
	if (entry.type !== "message") return { label: entry.type ?? "entry" };
	const message = entry.message ?? {};
	if (message.role === "toolResult") return { label: `${message.toolName ?? "tool"} result` };
	if (message.role === "user") return { label: "user message" };
	if (message.role === "assistant") {
		const calls = contentParts(message).filter((part) => part?.type === "toolCall");
		if (calls.length === 1) return { label: `${calls[0].name ?? "tool"} call`, path: toolPath(calls[0]) };
		if (calls.length > 1) return { label: `${calls.length} tool calls` };
		return { label: "assistant response" };
	}
	return { label: `${message.role ?? "message"} message` };
}

function previewText(text: string, limit = 180): string {
	const normalized = sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized || "(empty)";
}

function addCategory(map: Map<string, ContextCategory>, id: string, label: string, tokens: number): void {
	const category = map.get(id) ?? { id, label, tokens: 0, entries: 0 };
	category.tokens += tokens;
	category.entries += 1;
	map.set(id, category);
}

function categorizeMessage(message: any, categories: Map<string, ContextCategory>): void {
	if (message?.role === "user") {
		addCategory(categories, "user", "User messages", estimateEntryTokens({ type: "message", message }));
		return;
	}
	if (message?.role === "toolResult" || message?.role === "bashExecution") {
		addCategory(categories, "tool-results", "Tool results", estimateEntryTokens({ type: "message", message }));
		return;
	}
	if (message?.role !== "assistant") {
		addCategory(categories, "other", "Other messages", estimateEntryTokens({ type: "message", message }));
		return;
	}

	let answerChars = 0;
	let reasoningChars = 0;
	let toolChars = 0;
	for (const part of contentParts(message)) {
		if (part?.type === "thinking") reasoningChars += String(part.thinking ?? "").length;
		else if (part?.type === "text") answerChars += String(part.text ?? "").length;
		else if (part?.type === "toolCall") toolChars += `${part.name ?? "tool"}${stringify(part.arguments ?? {})}`.length;
		else answerChars += stringify(part).length;
	}
	if (reasoningChars > 0) addCategory(categories, "reasoning", "Assistant reasoning", Math.ceil(reasoningChars / 4));
	if (answerChars > 0) addCategory(categories, "answers", "Assistant answers", Math.ceil(answerChars / 4));
	if (toolChars > 0) addCategory(categories, "tool-calls", "Tool calls and arguments", Math.ceil(toolChars / 4));
	if (reasoningChars + answerChars + toolChars === 0) addCategory(categories, "answers", "Assistant answers", 0);
}

function latestAssistantUsage(entries: readonly any[]): any | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.usage) return entry.message.usage;
	}
	return undefined;
}

function skillNames(options: any): string[] {
	const skills = Array.isArray(options?.skills) ? options.skills : [];
	return skills.map((skill: any) => String(skill?.name ?? skill?.path ?? skill)).filter(Boolean);
}

function activeToolNames(options: any): string[] {
	const tools = Array.isArray(options?.activeTools) ? options.activeTools : Array.isArray(options?.tools) ? options.tools : [];
	return tools.map((tool: any) => typeof tool === "string" ? tool : String(tool?.name ?? tool?.id ?? "")).filter(Boolean);
}

export function analyzeContext(ctx: any): ContextAnalysis {
	const systemPrompt = String(ctx.getSystemPrompt?.() ?? "");
	const options = ctx.getSystemPromptOptions?.() ?? {};
	const activeEntries = ctx.sessionManager.buildContextEntries();
	const branchEntries = ctx.sessionManager.getBranch();
	const allEntries = ctx.sessionManager.getEntries();
	const activeIds = new Set(activeEntries.map((entry: any) => entry.id));
	const branchIds = new Set(branchEntries.map((entry: any) => entry.id));
	const categories = new Map<string, ContextCategory>();
	const largest: LargestContextEntry[] = [];
	let hiddenCustom = 0;

	for (const entry of activeEntries) {
		const tokens = estimateEntryTokens(entry);
		if (entry.type === "message") categorizeMessage(entry.message, categories);
		else if (entry.type === "compaction") addCategory(categories, "compaction", "Compaction summaries", tokens);
		else if (entry.type === "branch_summary") addCategory(categories, "branch-summary", "Branch summaries", tokens);
		else if (entry.type === "custom_message") {
			if (!entry.display) hiddenCustom += 1;
			addCategory(categories, "custom", "Custom context messages", tokens);
		}
		if (entryParticipatesInContext(entry)) {
			const smallestRetained = largest.at(-1)?.tokens ?? -1;
			if (largest.length < MAX_LARGEST_ENTRIES || tokens > smallestRetained) {
				const info = entryLabel(entry);
				largest.push({
					id: entry.id,
					label: sanitizeTerminalText(info.label),
					tokens,
					path: info.path ? sanitizeTerminalText(info.path) : undefined,
				});
				largest.sort((a, b) => b.tokens - a.tokens);
				if (largest.length > MAX_LARGEST_ENTRIES) largest.length = MAX_LARGEST_ENTRIES;
			}
		}
	}

	let compactedAwayTokens = 0;
	let compactedAwayEntries = 0;
	for (const entry of branchEntries) {
		if (!entryParticipatesInContext(entry) || activeIds.has(entry.id)) continue;
		compactedAwayEntries += 1;
		compactedAwayTokens += estimateEntryTokens(entry);
	}

	let inactiveTreeTokens = 0;
	let inactiveTreeEntries = 0;
	for (const entry of allEntries) {
		if (!entryParticipatesInContext(entry) || branchIds.has(entry.id)) continue;
		inactiveTreeEntries += 1;
		inactiveTreeTokens += estimateEntryTokens(entry);
	}

	const usage = ctx.getContextUsage?.();
	const latestUsage = latestAssistantUsage(activeEntries) ?? {};
	const contextFiles = (Array.isArray(options.contextFiles) ? options.contextFiles : [])
		.map((file: any) => String(file?.path ?? ""))
		.filter(Boolean);
	const orderedCategories = [...categories.values()].sort((a, b) => b.tokens - a.tokens);

	return {
		systemTokens: estimateTextTokens(systemPrompt),
		activeTranscriptTokens: orderedCategories.reduce((sum, category) => sum + category.tokens, 0),
		categories: orderedCategories,
		compactedAwayTokens,
		compactedAwayEntries,
		inactiveTreeTokens,
		inactiveTreeEntries,
		customHiddenEntries: hiddenCustom,
		providerTokens: usage?.tokens,
		contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		latestCacheRead: Math.max(0, latestUsage.cacheRead ?? 0),
		latestCacheWrite: Math.max(0, latestUsage.cacheWrite ?? 0),
		latestPromptInput: Math.max(0, latestUsage.input ?? 0),
		largest,
		contextFiles: contextFiles.map(sanitizeTerminalText),
		skills: skillNames(options).map(sanitizeTerminalText),
		activeTools: activeToolNames(options).map(sanitizeTerminalText),
	};
}

function analysisLines(analysis: ContextAnalysis, theme: any): string[] {
	const lines: string[] = [];
	const totalEstimated = analysis.systemTokens + analysis.activeTranscriptTokens;
	const used = analysis.providerTokens ?? totalEstimated;
	const percent = analysis.contextWindow ? Math.min(100, (used / analysis.contextWindow) * 100) : undefined;
	const row = (label: string, tokens: number, suffix = "") =>
		lines.push(`${label.padEnd(24)} ${theme.fg("accent", compactNumber(tokens).padStart(7))}${suffix ? ` ${theme.fg("dim", suffix)}` : ""}`);

	if (analysis.contextWindow) lines.push(`${theme.bold("Used")} ${compactNumber(used)} / ${compactNumber(analysis.contextWindow)}${percent === undefined ? "" : ` (${percent.toFixed(1)}%)`}`);
	else lines.push(`${theme.bold("Used")} ${compactNumber(used)}`);
	lines.push("");
	row("System prompt", analysis.systemTokens, `${analysis.contextFiles.length} files, ${analysis.skills.length} skills`);
	row("Active transcript", analysis.activeTranscriptTokens);
	for (const category of analysis.categories) row(`  ${category.label}`, category.tokens, `${category.entries}`);

	const cacheDenominator = analysis.latestPromptInput + analysis.latestCacheRead + analysis.latestCacheWrite;
	const cachePercent = cacheDenominator > 0 ? (analysis.latestCacheRead / cacheDenominator) * 100 : 0;
	lines.push("");
	row("Cache read", analysis.latestCacheRead, cacheDenominator > 0 ? `${cachePercent.toFixed(1)}%` : "");
	row("Uncached input", analysis.latestPromptInput);
	row("Compacted history", analysis.compactedAwayTokens, `${analysis.compactedAwayEntries} entries`);
	row("Inactive branches", analysis.inactiveTreeTokens, `${analysis.inactiveTreeEntries} entries`);
	lines.push(`Resources: ${analysis.contextFiles.length} files · ${analysis.skills.length} skills · ${analysis.activeTools.length} tools`);

	lines.push("");
	lines.push(theme.bold("Largest active entries"));
	if (analysis.largest.length === 0) lines.push(theme.fg("dim", "No context-visible entries."));
	analysis.largest.forEach((entry, index) => {
		const key = index < 9 ? String(index + 1) : "·";
		const path = entry.path ? ` · ${entry.path}` : "";
		lines.push(`${theme.fg("accent", key.padStart(2))} ${compactNumber(entry.tokens).padStart(7)}  ${entry.label}${theme.fg("dim", path)}`);
	});
	lines.push("", theme.fg("dim", "Estimates use chars/4; provider totals can differ."));
	return lines;
}

class ContextInspector {
	private scroll = 0;
	private cachedKey = "";
	private cachedLines: string[] = [];

	constructor(
		private readonly analysis: ContextAnalysis,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (result?: unknown) => void,
	) {}

	private sourceLines(): string[] {
		return analysisLines(this.analysis, this.theme);
	}

	private lines(width: number): string[] {
		const key = String(width);
		if (this.cachedKey === key) return this.cachedLines;
		const wrapped: string[] = [];
		for (const line of this.sourceLines()) {
			if (!line) { wrapped.push(""); continue; }
			wrapped.push(...wrapTextWithAnsi(line, Math.max(1, width)));
		}
		this.cachedKey = key;
		this.cachedLines = wrapped;
		return wrapped;
	}

	render(width: number): string[] {
		const max = Math.max(12, width);
		const innerWidth = Math.max(1, max - 4);
		const panelHeight = Math.max(8, Math.min(20, (process.stdout.rows || 24) - 4));
		const bodyHeight = panelHeight - 2;
		const lines = this.lines(innerWidth);
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const bodyRow = (line: string) => {
			const fitted = truncateToWidth(line, innerWidth, "…");
			return `| ${fitted}${" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))} |`;
		};
		const border = (label: string) => {
			const fitted = truncateToWidth(` ${label} `, Math.max(1, max - 2), "…");
			return `+${fitted}${"-".repeat(Math.max(0, max - 2 - visibleWidth(fitted)))}+`;
		};
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight).map(bodyRow);
		while (visible.length < bodyHeight) visible.push(bodyRow(""));
		const hint = "up/down scroll | PgUp/PgDn | q close";
		return [border("Context"), ...visible, border(hint)];
	}

	handleInput(data: string): void {
		const page = Math.max(4, Math.min(16, (process.stdout.rows || 24) - 8));
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
		else if (matchesKey(data, Key.pageDown)) this.scroll += page;
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
		this.tui.requestRender();
	}

	invalidate(): void { this.cachedKey = ""; }
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Explain what consumes the current model context window",
		handler: async (_args, ctx) => {
			const analysis = analyzeContext(ctx);
			analysis.activeTools = pi.getActiveTools().map(sanitizeTerminalText);
			if (ctx.mode !== "tui") {
				const total = analysis.systemTokens + analysis.activeTranscriptTokens;
				ctx.ui.notify(`Estimated context: ${compactNumber(total)} tokens; provider reports ${analysis.providerTokens == null ? "unknown" : compactNumber(analysis.providerTokens)}.`, "info");
				return;
			}
			pi.events.emit("modal-overlay", { id: "context", hidden: true });
			try {
				await ctx.ui.custom((tui: TUI, theme: any, _kb: any, done: (result: unknown) => void) =>
					new ContextInspector(analysis, tui, theme, done), {
						overlay: true,
						overlayOptions: { width: "72%", minWidth: 52, maxHeight: 20, anchor: "center", margin: 1 },
					});
			} finally {
				pi.events.emit("modal-overlay", { id: "context", hidden: false });
			}
		},
	});
}
