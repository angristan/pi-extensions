/**
 * diff — theme-aware palettes, syntax-highlighted line-numbered diff rendering,
 * and the width-aware WidthAwareLines component that truncates/wraps any rendered
 * lines to the live viewport width (used by every restyler, not just diffs).
 *
 * Depends on core's fitToolLine for non-diff line fitting. Diff coloring uses
 * pi's `highlightCode`/`getLanguageFromPath` for syntax when a path is given.
 */

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CYAN, GREEN, RED, RESET } from "./render.js";
import { fitToolLine } from "./core.js";

/** Per-name render-cache counters, published on a shared global so /doctor can
 *  report hit-rate + volatile churn for every width-aware component. */
const RENDER_STATS_KEY = Symbol.for("pi.renderer-cache.stats");

interface RendererCacheStats {
	renderCalls: number;
	cacheHits: number;
	cacheMisses: number;
	volatileRenders: number;
	invalidations: number;
}

function rendererCacheStats(name: string): RendererCacheStats {
	const root = globalThis as typeof globalThis & {
		[RENDER_STATS_KEY]?: Record<string, RendererCacheStats>;
	};
	const registry = root[RENDER_STATS_KEY] ??= {};
	return registry[name] ??= {
		renderCalls: 0,
		cacheHits: 0,
		cacheMisses: 0,
		volatileRenders: 0,
		invalidations: 0,
	};
}

const widthAwareStats = rendererCacheStats("better-native-pi");

type DiffKind = "add" | "delete";

interface DiffPalette {
	mode: "dark" | "light";
	addBackground: string;
	deleteBackground: string;
	addGutterBackground?: string;
	deleteGutterBackground?: string;
	gutterForeground?: string;
}

const ANSI_FG_RESET = "\x1b[39m";
const ANSI_BG_RESET = "\x1b[49m";

function xtermColor(index: number): [number, number, number] {
	const ansi16: Array<[number, number, number]> = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
		[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
		[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
		[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	if (index < 16) return ansi16[index] ?? [255, 255, 255];
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return [gray, gray, gray];
	}
	const cube = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	return [levels[Math.floor(cube / 36)], levels[Math.floor(cube / 6) % 6], levels[cube % 6]];
}

function ansiForegroundRgb(ansi: string): [number, number, number] | undefined {
	const truecolor = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (truecolor) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = ansi.match(/\x1b\[38;5;(\d+)m/);
	return indexed ? xtermColor(Number(indexed[1])) : undefined;
}

function isLightText(rgb: [number, number, number]): boolean {
	const [red, green, blue] = rgb.map((channel) => channel / 255);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue >= 0.55;
}

/** Copy fallback palettes, selecting light/dark from Pi's text color. */
export function diffPalette(theme: any): DiffPalette {
	if (!theme?.getFgAnsi || !theme?.getColorMode) {
		return { mode: "dark", addBackground: "\x1b[48;2;33;58;43m", deleteBackground: "\x1b[48;2;74;34;29m" };
	}
	const textRgb = ansiForegroundRgb(theme.getFgAnsi("text"));
	const mode: "dark" | "light" = textRgb && !isLightText(textRgb) ? "light" : "dark";
	if (theme.getColorMode() === "256color") {
		return mode === "dark"
			? { mode, addBackground: "\x1b[48;5;22m", deleteBackground: "\x1b[48;5;52m" }
			: {
				mode,
				addBackground: "\x1b[48;5;194m",
				deleteBackground: "\x1b[48;5;224m",
				addGutterBackground: "\x1b[48;5;157m",
				deleteGutterBackground: "\x1b[48;5;217m",
				gutterForeground: "\x1b[38;5;236m",
			};
	}
	return mode === "dark"
		? { mode, addBackground: "\x1b[48;2;33;58;43m", deleteBackground: "\x1b[48;2;74;34;29m" }
		: {
			mode,
			addBackground: "\x1b[48;2;218;251;225m",
			deleteBackground: "\x1b[48;2;255;235;233m",
			addGutterBackground: "\x1b[48;2;172;238;187m",
			deleteGutterBackground: "\x1b[48;2;255;206;203m",
			gutterForeground: "\x1b[38;2;31;35;40m",
		};
}

function diffLineInfo(line: string): { kind: DiffKind; gutterWidth: number; prefixWidth: number } | undefined {
	const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const match = plain.match(/^(\s*\d+\s)([+\-])/);
	if (!match) return undefined;
	const gutterWidth = visibleWidth(match[1]);
	return {
		kind: match[2] === "+" ? "add" : "delete",
		gutterWidth,
		prefixWidth: gutterWidth + 1,
	};
}

function wrapDiffLine(line: string, width: number, prefixWidth: number): string[] {
	const contentWidth = Math.max(1, width - prefixWidth);
	const totalWidth = visibleWidth(line);
	const prefix = sliceByColumn(line, 0, prefixWidth);
	const content = sliceByColumn(line, prefixWidth, Math.max(0, totalWidth - prefixWidth));
	const chunks = wrapTextWithAnsi(content, contentWidth);
	return chunks.map((chunk, index) => index === 0 ? `${prefix}${chunk}` : `${" ".repeat(prefixWidth)}${chunk}`);
}

function applyAnsiRegion(text: string, width: number, background: string, foreground = ""): string {
	const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
	const start = `${background}${foreground}`;
	// Full resets or explicit foreground/background resets inside syntax spans
	// must not punch holes in the line tint.
	const persistent = `${text}${padding}`.replace(
		/\x1b\[(?:0|39|49)m/g,
		(escape) => `${escape}${start}`,
	);
	return `${start}${persistent}${ANSI_FG_RESET}${ANSI_BG_RESET}`;
}

function applyDiffBackground(
	line: string,
	width: number,
	info: { kind: DiffKind; gutterWidth: number; prefixWidth: number },
	palette: DiffPalette,
): string {
	const background = info.kind === "add" ? palette.addBackground : palette.deleteBackground;
	const gutter = sliceByColumn(line, 0, info.gutterWidth);
	const body = sliceByColumn(line, info.gutterWidth, Math.max(0, visibleWidth(line) - info.gutterWidth));
	let styledGutter: string;
	if (palette.mode === "light") {
		const gutterBackground = info.kind === "add" ? palette.addGutterBackground : palette.deleteGutterBackground;
		styledGutter = gutterBackground && palette.gutterForeground
			? applyAnsiRegion(gutter, info.gutterWidth, gutterBackground, palette.gutterForeground)
			: applyAnsiRegion(gutter, info.gutterWidth, background);
	} else {
		styledGutter = applyAnsiRegion(gutter, info.gutterWidth, background);
	}
	const styledBody = applyAnsiRegion(body, Math.max(0, width - info.gutterWidth), background);
	// Terminate the composite row explicitly. ANSI-aware column slicing omits
	// zero-width trailing resets, which otherwise leak tint/style into later rows.
	return `${styledGutter}${styledBody}${RESET}`;
}

interface ParsedDiffLine {
	marker: " " | "+" | "-";
	lineNumber: string;
	content: string;
}

function parseDiffLine(line: string): ParsedDiffLine | undefined {
	// Pi emits `<marker><padded line number> <content>`, e.g. `- 2 old`.
	const match = line.match(/^([ +\-])(\s*\d+)\s(.*)$/);
	if (!match) return undefined;
	return {
		marker: match[1] as ParsedDiffLine["marker"],
		lineNumber: match[2],
		// Match Pi's built-in renderers. Literal tabs advance the terminal cursor
		// without painting skipped cells, which creates default-background blocks
		// inside an otherwise tinted diff row.
		content: match[3].replace(/\t/g, "   "),
	};
}

/** Syntax-highlight Pi's line-numbered diff using the `N +/-content` layout. */
export function colorizeDiff(diff: string, path?: string): string[] {
	const rawLines = diff.split("\n");
	const parsedLines = rawLines.map(parseDiffLine);
	const language = path ? getLanguageFromPath(path) : undefined;
	const syntaxLines = language
		? highlightCode(parsedLines.map((line) => line?.content ?? "").join("\n"), language)
		: [];

	return rawLines.map((line, index) => {
		const numbered = parsedLines[index];
		if (numbered) {
			const { marker, lineNumber, content } = numbered;
			const prefix = `${lineNumber} `;
			const syntax = syntaxLines[index] ?? content;
			if (marker === "+") {
				return language
					? `${prefix}${GREEN}+${RESET}${syntax}`
					: `${prefix}${GREEN}+${content}${RESET}`;
			}
			if (marker === "-") {
				return language
					? `${prefix}${RED}-${RESET}${syntax}`
					: `${prefix}${RED}-${content}${RESET}`;
			}
			return language
				? `${prefix} ${syntax}`
				: `${prefix} ${content}`;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) return `${GREEN}${line}${RESET}`;
		if (line.startsWith("-") && !line.startsWith("---")) return `${RED}${line}${RESET}`;
		if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
		return line;
	});
}

/**
 * A width-aware component: truncates each pre-composed (ANSI-colored) line to the
 * live viewport width so nothing soft-wraps past the gutter. Re-flows on resize
 * because render(width) is re-invoked by the TUI. Diff lines are tinted with the
 * provided palette when present.
 */
export class WidthAwareLines {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly source: string[] | (() => string[]),
		private readonly diffPalette?: DiffPalette,
		private readonly volatile = false,
	) {}

	invalidate(): void {
		widthAwareStats.invalidations += 1;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		widthAwareStats.renderCalls += 1;
		const max = Math.max(1, width);
		if (!this.volatile && this.cachedLines && this.cachedWidth === max) {
			widthAwareStats.cacheHits += 1;
			return this.cachedLines;
		}
		if (this.volatile) widthAwareStats.volatileRenders += 1;
		else widthAwareStats.cacheMisses += 1;

		const lines = typeof this.source === "function" ? this.source() : this.source;
		const rendered = lines.flatMap((line) => {
			const info = diffLineInfo(line);
			const fitted = visibleWidth(line) <= max
				? [line]
				: info
					? wrapDiffLine(line, max, info.prefixWidth)
					: [fitToolLine(line, max)];
			return info && this.diffPalette
				? fitted.map((row) => applyDiffBackground(row, max, info, this.diffPalette!))
				: fitted;
		});
		if (!this.volatile) {
			this.cachedWidth = max;
			this.cachedLines = rendered;
		}
		return rendered;
	}
}
