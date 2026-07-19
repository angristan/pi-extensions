import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type TranscriptEntry = any;

export interface TranscriptPagerOptions {
	title?: string;
	startAtEnd?: boolean;
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
	if (typeof args.reasoning === "string" && args.reasoning.trim()) lines.push(displayText(args.reasoning));
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

function section(
	symbol: string,
	label: string,
	labelColor: string,
	body: string,
	bodyColor: string,
	width: number,
	theme: any,
): string[] {
	const header = `${theme.fg(labelColor, symbol)} ${theme.fg(labelColor, label)}`;
	const indent = "  ";
	const available = Math.max(1, width - visibleWidth(indent));
	const rows = wrapTextWithAnsi(body || "(empty)", available);
	return [truncateToWidth(header, width, "…"), ...rows.map((row) => `${indent}${theme.fg(bodyColor, row)}`)];
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
			failed ? "error" : "muted",
			width,
			theme,
		);
	}
	if (message.role === "assistant") {
		const lines: string[] = [];
		const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
		for (const item of content) {
			if (item?.type === "thinking") {
				appendBlock(lines, section("·", "Thinking", "dim", displayText(item.thinking ?? ""), "dim", width, theme));
			} else if (item?.type === "text") {
				const text = displayText(item.text ?? "");
				if (text) appendBlock(lines, section("●", "Agent", "success", text, "text", width, theme));
			} else if (item?.type === "toolCall") {
				appendBlock(lines, section("◆", `Tool · ${item.name ?? "unknown"}`, "accent", toolArguments(item.arguments), "muted", width, theme));
			} else if (item?.type === "image") {
				appendBlock(lines, section("◇", "Image", "muted", "[image]", "muted", width, theme));
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
			if (body.length) body.push("");
			body.push(...rendered);
		}
		this.cachedWidth = width;
		this.cachedLines = body;
		return body;
	}
	render(width: number): string[] {
		const max = Math.max(1, width);
		const height = Math.max(8, (process.stdout.rows || 24) - 6);
		const bodyHeight = height - 2;
		const lines = this.lines(max);
		this.maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = this.followEnd ? this.maxScroll : Math.min(this.scroll, this.maxScroll);
		const percent = this.maxScroll === 0 ? 100 : Math.round((this.scroll / this.maxScroll) * 100);
		const title = this.options.title ?? "Transcript";
		const header = truncateToWidth(`${this.theme.fg("accent", title)} ${this.theme.fg("dim", `(${lines.length} rows)`)}`, max);
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, max, "…"));
		while (visible.length < bodyHeight) visible.push("");
		const footer = truncateToWidth(this.theme.fg("dim", `↑↓/PgUp/PgDn scroll · Home/End · q close · ${percent}%`), max);
		return [header, ...visible, footer];
	}
	handleInput(data: string): void {
		const page = Math.max(5, (process.stdout.rows || 24) - 10);
		if (matchesKey(data, Key.escape) || data === "q") return this.done();
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
