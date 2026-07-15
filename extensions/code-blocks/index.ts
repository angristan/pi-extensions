import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

const HOST_KEY = "code-blocks-host";
const PATCH = Symbol.for("pi.code-blocks.patch");

type MarkdownPrototype = {
	renderToken(token: any, width: number, nextTokenType?: string, styleContext?: any): string[];
	[PATCH]?: PatchState;
};

interface PatchState {
	owners: number;
	original: MarkdownPrototype["renderToken"];
}

function languageLabel(lang: unknown): string {
	if (typeof lang !== "string" || !lang.trim()) return "code";
	return lang.trim().split(/\s+/, 1)[0] || "code";
}

function fitBorderLabel(label: string, width: number): string {
	const available = Math.max(1, width - 4);
	return truncateToWidth(label, available, "…");
}

// How much to darken syntax colors inside styled blocks (e.g. thinking).
// 0.6 => keep 60% of each channel, i.e. visibly dimmed but still readable.
// Tunable: lower = dimmer. Only applied on the thinking path, never normal output.
const STYLE_DIM_FACTOR = 0.6;

/** xterm 256-color palette index → [r, g, b], matching the standard cube ramp. */
function xterm256ToRgb(n: number): [number, number, number] {
	if (n < 16) {
		// Basic 16 ANSI colors (VGA-ish). Good enough for dim blending.
		const basic: Array<[number, number, number]> = [
			[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
			[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
			[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
			[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
		];
		return basic[n];
	}
	if (n >= 232 && n <= 255) {
		// Grayscale ramp.
		const v = 8 + (n - 232) * 10;
		return [v, v, v];
	}
	// 6x6x6 color cube.
	const i = n - 16;
	const comp = (idx: number) => (idx === 0 ? 0 : 55 + idx * 40);
	return [comp(Math.floor(i / 36)), comp(Math.floor((i % 36) / 6)), comp(i % 6)];
}

/**
 * Scales foreground RGB toward black by `factor`, in place, across all SGR
 * sequences in the line. Handles true-color (38;2;R;G;B), 256-color (38;5;N),
 * and basic 16 (30-37, 90-97) foregrounds. Backgrounds, bold/italic, and resets
 * are passed through unchanged. This is real dimming — it rewrites the colors
 * rather than relying on SGR `2` (faint), which most terminals drop after a
 * syntax-highlighter reset.
 */
function dimAnsiForeground(line: string, factor: number): string {
	if (factor >= 1) return line;
	const scale = (r: number, g: number, b: number): [number, number, number] => [
		Math.round(r * factor),
		Math.round(g * factor),
		Math.round(b * factor),
	];
	return line.replace(/\x1b\[([\d;]*)m/g, (full, params: string) => {
		const parts = params === "" ? [] : params.split(";");
		if (parts.length === 0) return full; // full reset — leave as-is
		const out: string[] = [];
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);
			// True-color or 256-color foreground/background: consume the whole run.
			if (code === 38 || code === 48) {
				if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					const r = Number.parseInt(parts[i + 2], 10);
					const g = Number.parseInt(parts[i + 3], 10);
					const b = Number.parseInt(parts[i + 4], 10);
					if (code === 38) {
						const d = scale(r, g, b);
						out.push(`38;2;${d[0]};${d[1]};${d[2]}`);
					} else {
						// Background: pass through unchanged (syntax highlighting rarely emits bg).
						out.push(`48;2;${r};${g};${b}`);
					}
					i += 5;
					continue;
				}
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					const n = Number.parseInt(parts[i + 2], 10);
					if (code === 38) {
						const [r, g, b] = xterm256ToRgb(n);
						const d = scale(r, g, b);
						out.push(`38;2;${d[0]};${d[1]};${d[2]}`);
					} else {
						out.push(`48;5;${n}`);
					}
					i += 3;
					continue;
				}
			}
			// Basic foreground colors → convert to RGB then dim.
			if (code >= 30 && code <= 37) {
				const [r, g, b] = xterm256ToRgb(code - 30);
				const d = scale(r, g, b);
				out.push(`38;2;${d[0]};${d[1]};${d[2]}`);
				i += 1;
				continue;
			}
			if (code >= 90 && code <= 97) {
				const [r, g, b] = xterm256ToRgb(code - 90 + 8);
				const d = scale(r, g, b);
				out.push(`38;2;${d[0]};${d[1]};${d[2]}`);
				i += 1;
				continue;
			}
			// Anything else (bold, italic, dim, reset of a single attr, bg basic, etc.):
			// pass through verbatim.
			out.push(String(code));
			i += 1;
		}
		return `\x1b[${out.join(";")}m`;
	});
}

/**
 * Builds a (apply, prefix, dimFactor) bundle from a Markdown `defaultTextStyle`.
 *
 * `defaultTextStyle` is what the parent Markdown component passes down for styled
 * blocks (e.g. thinking traces use { color: thinkingText, italic: true }). Fenced
 * code blocks normally ignore it, so code inside thinking renders at full
 * brightness with no italic — indistinguishable from normal output.
 *
 * `apply(text)` wraps text with the style (color + italic + ...), matching how
 * Markdown.applyDefaultStyle works. `prefix` is the raw SGR escape extracted by
 * styling a sentinel, so it can be re-inserted after every `\x1b[0m` reset the
 * syntax highlighter emits mid-line. Without that re-insertion, italic only
 * survives up to the first reset and the rest of the line loses the thinking
 * style. This is the same trick the blockquote renderer uses.
 *
 * `dimFactor` is set when the style carries a foreground color (the thinking
 * case), so syntax-token colors get darkened on top of italic/gap-color.
 */
interface StyleApplier {
	apply: (text: string) => string;
	prefix: string;
	dimFactor: number;
}

function buildStyleApplier(theme: any, style: any): StyleApplier | undefined {
	if (!style) return undefined;
	const hasAny = style.color || style.bold || style.italic || style.strikethrough || style.underline;
	if (!hasAny) return undefined;
	const apply = (text: string) => {
		let out = text;
		if (style.color) out = style.color(out);
		if (style.bold) out = theme.bold(out);
		if (style.italic) out = theme.italic(out);
		if (style.strikethrough) out = theme.strikethrough(out);
		if (style.underline) out = theme.underline(out);
		return out;
	};
	// Extract the leading SGR prefix by styling a sentinel char and slicing
	// everything before it. Falls back to "" if the theme functions don't emit a
	// prefix (shouldn't happen, but stay safe).
	const sentinel = "\u0000";
	const styled = apply(sentinel);
	const idx = styled.indexOf(sentinel);
	const prefix = idx >= 0 ? styled.slice(0, idx) : "";
	// Dim syntax colors only when the parent style sets a foreground color
	// (thinking blocks do; other styled blocks usually don't).
	const dimFactor = style.color ? STYLE_DIM_FACTOR : 1;
	return { apply, prefix, dimFactor };
}

/**
 * Wraps a (possibly ANSI-colored) line with the parent block's default style,
 * re-establishing it after every SGR reset so italic/color survive across
 * syntax-highlighter token boundaries. Syntax foreground colors are darkened
 * first so thinking-block code reads as visibly dimmed. No-op when there is no
 * style (normal assistant output), preserving existing behavior.
 */
function applyStyleToLine(applier: StyleApplier | undefined, line: string): string {
	if (!applier) return line;
	const dimmed = applier.dimFactor < 1 ? dimAnsiForeground(line, applier.dimFactor) : line;
	const withPrefix = applier.prefix ? dimmed.replace(/\x1b\[0m/g, `\x1b[0m${applier.prefix}`) : dimmed;
	return applier.apply(withPrefix);
}

function renderCodeBlock(instance: any, token: any, width: number, nextTokenType?: string): string[] {
	const theme = instance.theme;
	const maxWidth = Math.max(1, width);
	const label = fitBorderLabel(languageLabel(token.lang), maxWidth);

	// Very narrow panes cannot support a useful box. They still get highlighted
	// code without exposing Markdown fence markers.
	if (maxWidth < 8) {
		const styleApplier = buildStyleApplier(theme, instance.defaultTextStyle);
		const rawLines = String(token.text ?? "").split("\n");
		const lines = rawLines.map((line) => applyStyleToLine(styleApplier, theme.codeBlock(line)));
		if (nextTokenType && nextTokenType !== "space") lines.push("");
		return lines;
	}

	const innerWidth = Math.max(1, maxWidth - 4);
	const labelText = ` ${label} `;
	const topFill = "─".repeat(Math.max(0, maxWidth - visibleWidth(labelText) - 2));
	const lines = [theme.codeBlockBorder(`╭${labelText}${topFill}╮`)];

	const highlighted = theme.highlightCode
		? theme.highlightCode(String(token.text ?? ""), token.lang)
		: String(token.text ?? "").split("\n").map((line: string) => theme.codeBlock(line));
	const sourceLines = highlighted.length > 0 ? highlighted : [""];

	// Re-apply the parent block's default style (e.g. thinking: dim + italic) on
	// top of the syntax-highlighted lines. Syntax token colors win for their own
	// spans; the thinking color fills the gaps and italic composes throughout.
	const styleApplier = buildStyleApplier(theme, instance.defaultTextStyle);

	for (const sourceLine of sourceLines) {
		const wrapped = wrapTextWithAnsi(applyStyleToLine(styleApplier, sourceLine), innerWidth);
		for (const row of wrapped.length > 0 ? wrapped : [""]) {
			const fitted = visibleWidth(row) <= innerWidth ? row : truncateToWidth(row, innerWidth, "");
			const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
			lines.push(
				`${theme.codeBlockBorder("│ ")}${fitted}${padding}${theme.codeBlockBorder(" │")}`,
			);
		}
	}

	lines.push(theme.codeBlockBorder(`╰${"─".repeat(Math.max(0, maxWidth - 2))}╯`));
	if (nextTokenType && nextTokenType !== "space") lines.push("");
	return lines;
}

function acquirePatch(): () => void {
	const prototype = Markdown.prototype as unknown as MarkdownPrototype;
	const existing = prototype[PATCH];
	if (existing) {
		existing.owners += 1;
		return () => releasePatch(prototype, existing);
	}

	const original = prototype.renderToken;
	const state: PatchState = { owners: 1, original };
	prototype[PATCH] = state;
	prototype.renderToken = function renderToken(
		this: any,
		token: any,
		width: number,
		nextTokenType?: string,
		styleContext?: any,
	): string[] {
		if (token?.type === "code") return renderCodeBlock(this, token, width, nextTokenType);
		return original.call(this, token, width, nextTokenType, styleContext);
	};

	return () => releasePatch(prototype, state);
}

function releasePatch(prototype: MarkdownPrototype, state: PatchState): void {
	state.owners -= 1;
	if (state.owners > 0 || prototype[PATCH] !== state) return;
	prototype.renderToken = state.original;
	delete prototype[PATCH];
}

class CodeBlockHost implements Component {
	private readonly release: () => void;
	private disposed = false;

	constructor(private readonly tui: TUI) {
		this.release = acquirePatch();
		tui.invalidate();
		tui.requestRender(true);
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.release();
	}
}

export default function (pi: ExtensionAPI) {
	let host: CodeBlockHost | undefined;

	const clear = (ctx: any) => {
		ctx.ui.setWidget(HOST_KEY, undefined);
		host = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		clear(ctx);
		ctx.ui.setWidget(HOST_KEY, (tui: TUI) => {
			host = new CodeBlockHost(tui);
			return host;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") clear(ctx);
	});
}
