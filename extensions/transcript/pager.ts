import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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

function contentText(content: any): string {
	if (typeof content === "string") return displayText(content);
	if (!Array.isArray(content)) return "";
	return content.map((item) => {
		if (item?.type === "text" || item?.type === "thinking") {
			return displayText(item.text ?? item.thinking ?? "");
		}
		if (item?.type === "toolCall") return `tool: ${item.name ?? "unknown"} ${JSON.stringify(item.arguments ?? {})}`;
		if (item?.type === "image") return "[image]";
		return "";
	}).filter(Boolean).join("\n");
}

function entryLines(entry: TranscriptEntry, width: number, theme: any): string[] {
	const wrap = (prefix: string, text: string, color: string) => {
		const available = Math.max(1, width - prefix.length);
		const rows = wrapTextWithAnsi(text || "(empty)", available);
		return rows.map((row, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${theme.fg(color, row)}`);
	};
	if (entry.type === "message") {
		const message = entry.message ?? {};
		const role = message.role ?? "message";
		const prefix = role === "user" ? "› " : role === "assistant" ? "• " : "  ";
		const color = role === "user" ? "accent" : role === "assistant" ? "text" : "muted";
		return wrap(prefix, contentText(message.content), color);
	}
	if (entry.type === "compaction") return wrap("• ", `Context compacted: ${entry.summary}`, "muted");
	if (entry.type === "branch_summary") return wrap("• ", `Branch summary: ${entry.summary}`, "muted");
	if (entry.type === "model_change") return wrap("• ", `Model changed to ${entry.provider}/${entry.modelId}`, "dim");
	if (entry.type === "thinking_level_change") return wrap("• ", `Thinking level: ${entry.thinkingLevel}`, "dim");
	if (entry.type === "custom_message" && entry.display) return wrap("• ", contentText(entry.content), "muted");
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
