/**
 * shell — bash/sh syntax highlighting. A small tokenizer that colors keywords,
 * commands, operators, variables, strings, comments, and numbers, theme-aware
 * with raw-ANSI fallbacks so it renders even without a pi theme.
 *
 * Used by the `bash` restyler (command detail on line 2 + expanded view) and by
 * core's argDetail/expandedLines. Depends only on the palette (render.ts).
 */

import { CYAN, GREEN, MAGENTA, RESET } from "./render.js";

/** Regex for a truecolor foreground ANSI sequence `[38;2;R;G;Bm`. */
const TRUECOLOR_FG = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
/** Regex for an indexed (256-color) foreground ANSI sequence `[38;5;Nm`. */
const INDEXED_FG = /\x1b\[38;5;(\d+)m/;

/** xterm 256-color index → approximate RGB. */
function xterm256ToRgb(index: number): [number, number, number] {
	if (index < 16) {
		const basic: Array<[number, number, number]> = [
			[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
			[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
			[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
			[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
		];
		return basic[index] ?? [255, 255, 255];
	}
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return [gray, gray, gray];
	}
	const cube = index - 16;
	const levels = [0, 95, 135, 175, 215, 255];
		return [levels[Math.floor(cube / 36)], levels[Math.floor(cube / 6) % 6], levels[cube % 6]];
}

/** RGB (0-255) → HSL (h in degrees, s/l in [0,1]). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	let h = 0, s = 0;
	const l = (max + min) / 2;
	const d = max - min;
	if (d !== 0) {
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r: h = (g - b) / d + (g < b ? 6 : 0); break;
			case g: h = (b - r) / d + 2; break;
			default: h = (r - g) / d + 4; break;
		}
		h *= 60;
	}
	return [h, s, l];
}

/** HSL → RGB (0-255). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	h /= 360;
	const hue = (p: number, q: number, t: number) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [Math.round(hue(p, q, h + 1 / 3) * 255), Math.round(hue(p, q, h) * 255), Math.round(hue(p, q, h - 1 / 3) * 255)];
}

/**
 * Shift a color's lightness by `factor` toward black (dark themes) or white
 * (light themes). Preserves hue + saturation so the color keeps its identity.
 */
function shadeRgb(rgb: [number, number, number], factor: number, lighten: boolean): [number, number, number] {
	const [h, s, l] = rgbToHsl(...rgb);
	const target = lighten ? 1 : 0;
	return hslToRgb(h, s, l + (target - l) * factor);
}

/** Dim an ANSI foreground by shifting its lightness; passes through if unknown. */
function dimAnsiFg(ansi: string, factor: number, lighten: boolean): string {
	const tc = ansi.match(TRUECOLOR_FG);
	if (tc) {
		const dim = shadeRgb([Number(tc[1]), Number(tc[2]), Number(tc[3])], factor, lighten);
		return `\x1b[38;2;${dim[0]};${dim[1]};${dim[2]}m`;
	}
	const idx = ansi.match(INDEXED_FG);
	if (idx) {
		const dim = shadeRgb(xterm256ToRgb(Number(idx[1])), factor, lighten);
		return `\x1b[38;2;${dim[0]};${dim[1]};${dim[2]}m`;
	}
	return ansi;
}

/**
 * Wrap a theme so `fg(color, text)` renders in a lightly dimmer shade of the
 * original color (lightness shifted toward black on dark themes, toward white
 * on light). Preserves hue/saturation, so syntax tokens keep their identity
 * but recede slightly — a middle tier between full-bright and the 50% ANSI DIM
 * used for tool output. `factor≈0.25` is a gentle dim, clearly brighter than DIM.
 */
export function dimTheme(theme: any, factor = 0.25): any {
	if (!theme || typeof theme.fg !== "function" || typeof theme.getFgAnsi !== "function") return theme;
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "dark";
	const lighten = mode === "light";
	return {
		...theme,
		fg: (color: string, text: string) => {
			const original = theme.getFgAnsi(color);
			const dim = dimAnsiFg(original, factor, lighten);
			return `${dim}${text}\x1b[39m`;
		},
	};
}



type ShellSyntaxColor =
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxOperator";

const SHELL_KEYWORDS = new Set([
	"if", "then", "elif", "else", "fi", "for", "select", "while", "until",
	"do", "done", "case", "in", "esac", "function", "time", "coproc", "!",
]);
const SHELL_COMMAND_PREFIXES = new Set(["builtin", "command", "env", "exec", "nohup", "sudo", "time"]);
const SHELL_OPERATORS = [";;&", "<<-", "&&", "||", "|&", ">>", "<<", "&>", "<>", ">&", "<&", ";;", ";&", "(", ")", ";", "|", "&", ">", "<"];
const SHELL_FALLBACK_COLORS: Record<ShellSyntaxColor, string> = {
	syntaxComment: "\x1b[90m",          // bright black (grey) — subdued
	syntaxKeyword: MAGENTA,        // \x1b[35m — if/for/done
	syntaxFunction: CYAN,           // \x1b[36m — command names
	syntaxVariable: "\x1b[33m",     // yellow — $VAR
	syntaxString: GREEN,            // \x1b[32m — "quoted"
	syntaxNumber: "\x1b[93m",       // bright yellow — distinct from green strings
	syntaxOperator: "\x1b[90m",    // bright black (grey) — | && > distinct from magenta keywords
};

function shellColor(theme: any, color: ShellSyntaxColor, text: string): string {
	if (!text) return "";
	return typeof theme?.fg === "function"
		? theme.fg(color, text)
		: `${SHELL_FALLBACK_COLORS[color]}${text}${RESET}`;
}

function shellOperatorAt(line: string, offset: number): string | undefined {
	return SHELL_OPERATORS.find((operator) => line.startsWith(operator, offset));
}

function shellVariableEnd(line: string, offset: number): number {
	const next = line[offset + 1];
	if (next === "{" || next === "(") {
		const open = next;
		const close = open === "{" ? "}" : ")";
		let depth = 1;
		let quote = "";
		for (let index = offset + 2; index < line.length; index++) {
			const character = line[index]!;
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (quote) {
				if (character === quote) quote = "";
				continue;
			}
			if (character === "'" || character === '"') {
				quote = character;
				continue;
			}
			if (character === open) depth += 1;
			else if (character === close && --depth === 0) return index + 1;
		}
		return line.length;
	}
	if (next && /[A-Za-z0-9_?@*#$!\-]/.test(next)) {
		let index = offset + 2;
		if (/[A-Za-z_]/.test(next)) while (index < line.length && /[A-Za-z0-9_]/.test(line[index]!)) index += 1;
		return index;
	}
	return offset + 1;
}

function highlightedDoubleQuote(line: string, offset: number, theme: any): { text: string; end: number } {
	let output = "";
	let chunk = '"';
	let index = offset + 1;
	const flush = () => {
		output += shellColor(theme, "syntaxString", chunk);
		chunk = "";
	};
	while (index < line.length) {
		const character = line[index]!;
		if (character === "\\" && index + 1 < line.length) {
			chunk += `${character}${line[index + 1]}`;
			index += 2;
			continue;
		}
		if (character === "$") {
			flush();
			const end = shellVariableEnd(line, index);
			output += shellColor(theme, "syntaxVariable", line.slice(index, end));
			index = end;
			continue;
		}
		chunk += character;
		index += 1;
		if (character === '"') break;
	}
	flush();
	return { text: output, end: index };
}

export function highlightedShellLine(line: string, theme?: any): string {
	let output = "";
	let offset = 0;
	let expectCommand = true;
	while (offset < line.length) {
		const character = line[offset]!;
		if (/\s/.test(character)) {
			output += character;
			offset += 1;
			continue;
		}
		if (character === "#" && (offset === 0 || /\s/.test(line[offset - 1]!))) {
			output += shellColor(theme, "syntaxComment", line.slice(offset));
			break;
		}
		if (character === "'") {
			let end = offset + 1;
			while (end < line.length && line[end] !== "'") end += 1;
			if (end < line.length) end += 1;
			output += shellColor(theme, "syntaxString", line.slice(offset, end));
			offset = end;
			expectCommand = false;
			continue;
		}
		if (character === '"') {
			const quoted = highlightedDoubleQuote(line, offset, theme);
			output += quoted.text;
			offset = quoted.end;
			expectCommand = false;
			continue;
		}
		if (character === "$") {
			const end = shellVariableEnd(line, offset);
			output += shellColor(theme, "syntaxVariable", line.slice(offset, end));
			offset = end;
			expectCommand = false;
			continue;
		}
		if (character === "`") {
			let end = offset + 1;
			while (end < line.length) {
				if (line[end] === "\\") end += 2;
				else if (line[end++] === "`") break;
			}
			output += shellColor(theme, "syntaxVariable", line.slice(offset, end));
			offset = end;
			expectCommand = false;
			continue;
		}
		const operator = shellOperatorAt(line, offset);
		if (operator) {
			output += shellColor(theme, "syntaxOperator", operator);
			offset += operator.length;
			if (["&&", "||", "|", "|&", ";", ";;", ";&", ";;&", "&", "("].includes(operator)) expectCommand = true;
			continue;
		}

		let end = offset + 1;
		while (end < line.length) {
			const next = line[end]!;
			if (/\s/.test(next) || next === "'" || next === '"' || next === "$" || next === "`" || shellOperatorAt(line, end)) break;
			end += 1;
		}
		const token = line.slice(offset, end);
		const assignment = token.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/);
		if (assignment) {
			output += shellColor(theme, "syntaxVariable", assignment[1] ?? "");
			output += shellColor(theme, "syntaxOperator", assignment[2] ?? "=");
			if (assignment[3]) output += assignment[3];
		} else if (SHELL_KEYWORDS.has(token)) {
			output += shellColor(theme, "syntaxKeyword", token);
			expectCommand = ["if", "then", "elif", "else", "do", "while", "until", "time", "!"].includes(token);
		} else if (/^--?[A-Za-z0-9]/.test(token)) {
			output += shellColor(theme, "syntaxKeyword", token);
			expectCommand = false;
		} else if (/^\d+(?:\.\d+)?$/.test(token)) {
			output += shellColor(theme, "syntaxNumber", token);
			expectCommand = false;
		} else if (expectCommand) {
			output += shellColor(theme, "syntaxFunction", token);
			expectCommand = SHELL_COMMAND_PREFIXES.has(token);
		} else {
			output += token;
		}
		offset = end;
	}
	return output;
}

/** Highlight a (possibly multi-line) shell command, joining lines with a themed ↵. */
export function highlightShellCommand(command: string, theme?: any): string {
	const normalized = command.replace(/\t/g, "   ").replace(/\s+$/, "");
	if (!normalized) return "";
	const newline = ` ${typeof theme?.fg === "function" ? theme.fg("accent", "↵") : `${CYAN}↵${RESET}`} `;
	return normalized.split("\n").map((line) => highlightedShellLine(line.trim(), theme)).join(newline);
}
