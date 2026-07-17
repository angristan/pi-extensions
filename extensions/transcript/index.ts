import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Entry = any;

function displayText(value: string): string {
	return value
		.replace(/<!-- pi:web-search(?:-(?:query(?:-count)?|source(?:-count)?))?:[^>]* -->/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function contentText(content: any): string {
	if (typeof content === "string") return content;
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

function entryLines(entry: Entry, width: number, theme: any): string[] {
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

class TranscriptPager {
	private scroll = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	constructor(
		private readonly entries: Entry[],
		private readonly theme: any,
		private readonly requestRender: () => void,
		private readonly done: () => void,
	) {}
	invalidate(): void { this.cachedWidth = 0; }
	private lines(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedLines;
		const body: string[] = [];
		for (const entry of this.entries) {
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
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const percent = maxScroll === 0 ? 100 : Math.round((this.scroll / maxScroll) * 100);
		const header = truncateToWidth(`${this.theme.fg("accent", "Transcript")} ${this.theme.fg("dim", `(${lines.length} rows)`)}`, max);
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, max, "…"));
		while (visible.length < bodyHeight) visible.push("");
		const footer = truncateToWidth(this.theme.fg("dim", `↑↓/PgUp/PgDn scroll · Home/End · q close · ${percent}%`), max);
		return [header, ...visible, footer];
	}
	handleInput(data: string): void {
		const page = Math.max(5, (process.stdout.rows || 24) - 10);
		if (matchesKey(data, Key.escape) || data === "q") return this.done();
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll++;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
		else if (matchesKey(data, Key.pageDown)) this.scroll += page;
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
		this.requestRender();
	}
}

export default function (pi: ExtensionAPI) {
	const showTranscript = async (ctx: any) => {
		const entries = ctx.sessionManager.getBranch();
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) =>
			new TranscriptPager(entries, theme, () => tui.requestRender(), done), {
			overlay: true,
			overlayOptions: { width: "95%", maxHeight: "92%", anchor: "center", margin: 1 },
		});
	};

	pi.registerCommand("transcript", { description: "Open a full scrollable transcript", handler: async (_args, ctx) => showTranscript(ctx) });
	pi.registerShortcut("ctrl+shift+t", { description: "Open full transcript", handler: showTranscript });
}
