import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { normalizeToolReasoning } from "../better-native-pi/core.js";

export type TranscriptEntry = any;

export interface TranscriptPagerOptions {
	title?: string | (() => string);
	headerLines?: (width: number) => string[];
	startAtEnd?: boolean;
	maxHeight?: () => number;
	onPrevious?: () => boolean;
	onNext?: () => boolean;
	navigationHint?: () => string;
}

export const TRANSCRIPT_OVERLAY_OPTIONS = {
	width: "95%",
	maxHeight: "92%",
	anchor: "center",
	margin: 1,
} as const;

export function resolveTranscriptOverlayHeight(terminalRows: number): number {
	const rows = Math.max(1, Math.floor(terminalRows));
	const percentageBudget = Math.floor(rows * 0.92);
	const marginBudget = rows - (TRANSCRIPT_OVERLAY_OPTIONS.margin * 2);
	return Math.max(1, Math.min(percentageBudget, marginBudget));
}

function displayText(value: string): string {
	return value
		.replace(/<!-- pi:web-search(?:-(?:query(?:-count)?|source(?:-count)?))?:[^>]* -->/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function textContent(content: any): string {
	if (typeof content === "string") return displayText(content);
	if (!Array.isArray(content)) return "";
	return content
		.filter((item) => item?.type === "text")
		.map((item) => displayText(item.text ?? ""))
		.filter(Boolean)
		.join("\n");
}

function compactValue(value: unknown): string {
	if (typeof value === "string") {
		const text = displayText(value);
		return text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars)` : text;
	}
	if (value === undefined) return "";
	try {
		const text = JSON.stringify(value);
		return text.length > 600 ? `${text.slice(0, 600)}… (${text.length} chars)` : text;
	} catch {
		return String(value);
	}
}

function toolArguments(args: any): string {
	if (!args || typeof args !== "object") return "(no arguments)";
	const lines: string[] = [];
	if (typeof args.reasoning === "string" && args.reasoning.trim()) lines.push(displayText(normalizeToolReasoning(args.reasoning)));
	for (const [key, value] of Object.entries(args)) {
		if (key === "reasoning") continue;
		if (key === "edits" && Array.isArray(value)) {
			lines.push(`${key}  ${value.length} replacement${value.length === 1 ? "" : "s"}`);
			continue;
		}
		const formatted = compactValue(value);
		if (formatted) lines.push(`${key}  ${formatted}`);
	}
	return lines.join("\n") || "(no arguments)";
}

function strong(theme: any, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function section(
	symbol: string,
	label: string,
	labelColor: string,
	body: string,
	bodyColor: string,
	width: number,
	theme: any,
): string[] {
	const header = `${theme.fg(labelColor, symbol)} ${theme.fg(labelColor, strong(theme, label))}`;
	const indent = "  ";
	const available = Math.max(1, width - visibleWidth(indent));
	const rows = wrapTextWithAnsi(body || "(empty)", available);
	return [truncateToWidth(header, width, "…"), ...rows.map((row) => `${indent}${theme.fg(bodyColor, row)}`)];
}

function markdownSection(symbol: string, label: string, body: string, width: number, theme: any): string[] {
	const header = `${theme.fg("success", symbol)} ${theme.fg("success", strong(theme, label))}`;
	const indent = "  ";
	const available = Math.max(1, width - visibleWidth(indent));
	const rows = new Markdown(body || "(empty)", 0, 0, getMarkdownTheme()).render(available);
	return [truncateToWidth(header, width, "…"), ...rows.map((row) => `${indent}${row}`)];
}

function paintOverlayRow(line: string, width: number, theme: any): string {
	const clipped = truncateToWidth(line, width, "…");
	if (typeof theme.bg !== "function") return clipped;
	const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	return theme.bg("customMessageBg", padded);
}

function appendBlock(lines: string[], block: string[]): void {
	if (lines.length > 0) lines.push("");
	lines.push(...block);
}

function messageLines(entry: TranscriptEntry, width: number, theme: any): string[] {
	const message = entry.message ?? {};
	if (message.role === "user") {
		return section("›", entry.transcriptLabel ?? "User", "accent", textContent(message.content), "text", width, theme);
	}
	if (message.role === "toolResult") {
		const failed = Boolean(message.isError);
		return section(
			failed ? "×" : "✓",
			`${failed ? "Tool failed" : "Tool result"} · ${message.toolName ?? "unknown"}`,
			failed ? "error" : "success",
			textContent(message.content),
			failed ? "error" : "toolOutput",
			width,
			theme,
		);
	}
	if (message.role === "assistant") {
		const lines: string[] = [];
		const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
		for (const item of content) {
			if (item?.type === "thinking") {
				appendBlock(lines, section("·", "Thinking", "muted", displayText(item.thinking ?? ""), "thinkingText", width, theme));
			} else if (item?.type === "text") {
				const text = displayText(item.text ?? "");
				if (text) appendBlock(lines, markdownSection("●", "Agent", text, width, theme));
			} else if (item?.type === "toolCall") {
				appendBlock(lines, section("◆", `Tool · ${item.name ?? "unknown"}`, "accent", toolArguments(item.arguments), "toolOutput", width, theme));
			} else if (item?.type === "image") {
				appendBlock(lines, section("◇", "Image", "muted", "[image]", "toolOutput", width, theme));
			}
		}
		return lines;
	}
	return section("•", String(message.role ?? "Message"), "muted", textContent(message.content), "muted", width, theme);
}

function entryLines(entry: TranscriptEntry, width: number, theme: any): string[] {
	if (entry.type === "message") return messageLines(entry, width, theme);
	if (entry.type === "compaction") return section("•", "Context compacted", "muted", entry.summary ?? "", "muted", width, theme);
	if (entry.type === "branch_summary") return section("•", "Branch summary", "muted", entry.summary ?? "", "muted", width, theme);
	if (entry.type === "model_change") return section("•", "Model", "dim", `${entry.provider}/${entry.modelId}`, "dim", width, theme);
	if (entry.type === "thinking_level_change") return section("•", "Thinking level", "dim", entry.thinkingLevel ?? "", "dim", width, theme);
	if (entry.type === "custom_message" && entry.display) return section("•", "Note", "muted", textContent(entry.content), "muted", width, theme);
	return [];
}

export class TranscriptPager {
	private scroll = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private followEnd: boolean;
	private maxScroll = 0;
	private bodyHeight = 1;
	constructor(
		private readonly getEntries: () => TranscriptEntry[],
		private readonly theme: any,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly options: TranscriptPagerOptions = {},
	) {
		this.followEnd = Boolean(options.startAtEnd);
	}
	invalidate(): void { this.cachedWidth = 0; }
	private lines(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedLines;
		const body: string[] = [];
		for (const entry of this.getEntries()) {
			const rendered = entryLines(entry, width, this.theme);
			if (!rendered.length) continue;
			if (body.length) body.push(this.theme.fg("border", "─".repeat(width)));
			body.push(...rendered);
		}
		this.cachedWidth = width;
		this.cachedLines = body;
		return body;
	}
	render(width: number): string[] {
		const max = Math.max(1, width);
		const height = Math.max(1, Math.floor(this.options.maxHeight?.() ?? resolveTranscriptOverlayHeight(process.stdout.rows || 24)));
		const lines = this.lines(max);
		const title = typeof this.options.title === "function" ? this.options.title() : (this.options.title ?? "Transcript");
		const defaultHeader = `${this.theme.fg("accent", title)} ${this.theme.fg("dim", `(${lines.length} rows)`)}`;
		const headers = (this.options.headerLines?.(max) ?? [defaultHeader])
			.map((line) => truncateToWidth(line, max, "…"));
		if (height <= headers.length) return headers.slice(0, height).map((line) => paintOverlayRow(line, max, this.theme));
		this.bodyHeight = Math.max(0, height - headers.length - 1);
		this.maxScroll = Math.max(0, lines.length - this.bodyHeight);
		this.scroll = this.followEnd ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
		const percent = this.maxScroll === 0 ? 100 : Math.round((this.scroll / this.maxScroll) * 100);
		const visible = lines.slice(this.scroll, this.scroll + this.bodyHeight).map((line) => truncateToWidth(line, max, "…"));
		while (visible.length < this.bodyHeight) visible.push("");
		const navigationHint = this.options.navigationHint?.();
		const controls = [navigationHint, "↑↓/PgUp/PgDn scroll", "Home/End", "q close", `${percent}%`].filter(Boolean).join(" · ");
		const footer = truncateToWidth(this.theme.fg("muted", controls), max);
		return [...headers, ...visible, footer].map((line) => paintOverlayRow(line, max, this.theme));
	}
	handleInput(data: string): void {
		const page = Math.max(1, this.bodyHeight - 2);
		if (matchesKey(data, Key.escape) || data === "q") return this.done();
		if (matchesKey(data, Key.left) && this.options.onPrevious) {
			if (this.options.onPrevious()) {
				this.followEnd = true;
				this.scroll = 0;
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.right) && this.options.onNext) {
			if (this.options.onNext()) {
				this.followEnd = true;
				this.scroll = 0;
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.followEnd = false;
			this.scroll = Math.max(0, this.scroll - 1);
		} else if (matchesKey(data, Key.down)) {
			this.scroll = Math.min(this.maxScroll, this.scroll + 1);
			this.followEnd = this.scroll >= this.maxScroll;
		} else if (matchesKey(data, Key.pageUp)) {
			this.followEnd = false;
			this.scroll = Math.max(0, this.scroll - page);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scroll = Math.min(this.maxScroll, this.scroll + page);
			this.followEnd = this.scroll >= this.maxScroll;
		} else if (matchesKey(data, Key.home)) {
			this.followEnd = false;
			this.scroll = 0;
		} else if (matchesKey(data, Key.end)) {
			this.followEnd = true;
			this.scroll = this.maxScroll;
		}
		this.requestRender();
	}
}
