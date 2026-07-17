/**
 * Dependency graph:
 * Direct: `./render.js`, `@earendil-works/pi-tui`.
 * Used by: `extensions/better-native-pi/core.ts`, `extensions/better-native-pi/shell.test.ts`.
 */
/**
 * shell — bash/sh syntax highlighting. A small tokenizer that colors keywords,
 * commands, operators, variables, strings, comments, and numbers, theme-aware
 * with raw-ANSI fallbacks so it renders even without a pi theme.
 *
 * Used by the `bash` restyler (command detail on line 2 + expanded view) and by
 * core's argDetail/expandedLines. Depends only on the palette (render.ts).
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { CYAN, GREEN, MAGENTA, RESET } from "./render.js";





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

interface DisplaySegment {
	text: string;
	operator?: string;
}

/** Split a long shell line at top-level chain operators without touching quotes. */
function displaySegments(line: string): DisplaySegment[] {
	const segments: DisplaySegment[] = [];
	let start = 0;
	let quote = "";
	let parenDepth = 0;
	let braceDepth = 0;
	let testDepth = 0;

	for (let index = 0; index < line.length; index++) {
		const character = line[index]!;
		if (quote) {
			if (character === "\\" && quote !== "'") index += 1;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (line.startsWith("[[", index)) {
			testDepth += 1;
			index += 1;
			continue;
		}
		if (testDepth > 0 && line.startsWith("]]", index)) {
			testDepth -= 1;
			index += 1;
			continue;
		}
		if (character === "(") {
			parenDepth += 1;
			continue;
		}
		if (character === ")" && parenDepth > 0) {
			parenDepth -= 1;
			continue;
		}
		if (character === "{") {
			braceDepth += 1;
			continue;
		}
		if (character === "}" && braceDepth > 0) {
			braceDepth -= 1;
			continue;
		}
		if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) break;
		if (parenDepth > 0 || braceDepth > 0 || testDepth > 0) continue;

		let operator: string | undefined;
		if (line.startsWith("&&", index) || line.startsWith("||", index) || line.startsWith("|&", index)) {
			operator = line.slice(index, index + 2);
		} else if (character === "|") {
			operator = character;
		} else if (character === ";" && line[index - 1] !== ";" && ![";", "&"].includes(line[index + 1] ?? "")) {
			operator = character;
		}
		if (!operator) continue;

		const text = line.slice(start, index).trim();
		if (text) segments.push({ text, operator });
		start = index + operator.length;
		index += operator.length - 1;
	}

	const tail = line.slice(start).trim();
	if (tail) segments.push({ text: tail });
	return segments.length > 0 ? segments : [{ text: line.trim() }];
}

/** Split display words while preserving whitespace inside shell quotes/groups. */
function displayWords(text: string): string[] {
	const words: string[] = [];
	let start = -1;
	let quote = "";
	let parenDepth = 0;
	let braceDepth = 0;

	const flush = (end: number) => {
		if (start >= 0) words.push(text.slice(start, end));
		start = -1;
	};
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (quote) {
			if (character === "\\" && quote !== "'") index += 1;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			if (start < 0) start = index;
			quote = character;
			continue;
		}
		if (character === "\\") {
			if (start < 0) start = index;
			index += 1;
			continue;
		}
		if (character === "(") parenDepth += 1;
		else if (character === ")" && parenDepth > 0) parenDepth -= 1;
		else if (character === "{") braceDepth += 1;
		else if (character === "}" && braceDepth > 0) braceDepth -= 1;
		if (/\s/.test(character) && parenDepth === 0 && braceDepth === 0) {
			flush(index);
			continue;
		}
		if (start < 0) start = index;
	}
	flush(text.length);
	return words;
}

function wrapDisplayWords(words: string[], firstIndent: string, continuationIndent: string, width: number): string[] {
	const rows: string[][] = [];
	let row: string[] = [];
	for (const word of words) {
		const indent = rows.length === 0 ? firstIndent : continuationIndent;
		const candidate = `${indent}${[...row, word].join(" ")}`;
		if (row.length === 0 || visibleWidth(candidate) <= width) {
			row.push(word);
		} else {
			rows.push(row);
			row = [word];
		}
	}
	if (row.length > 0) rows.push(row);

	// Avoid an operator stranded on its own continuation row.
	const last = rows.at(-1);
	const previous = rows.at(-2);
	if (last?.length === 1 && /^(?:&&|\|\||\||\|&|;)$/.test(last[0]!) && previous && previous.length > 1) {
		last.unshift(previous.pop()!);
	}
	return rows.map((wordsInRow, index) => `${index === 0 ? firstIndent : continuationIndent}${wordsInRow.join(" ")}`);
}

/**
 * Format a command for display only. Existing short/source lines stay untouched;
 * long lines break at shell chain operators, then at quote-aware word boundaries.
 */
export function formatShellCommandForDisplay(command: string, width: number): string[] {
	const max = Math.max(1, width);
	const output: string[] = [];
	for (const sourceLine of command.split("\n")) {
		if (visibleWidth(sourceLine) <= max) {
			output.push(sourceLine);
			continue;
		}
		const sourceIndent = sourceLine.match(/^\s*/)?.[0] ?? "";
		const lineRows: string[] = [];
		for (const segment of displaySegments(sourceLine.trim())) {
			const firstIndent = sourceIndent;
			const continuationIndent = `${sourceIndent}  `;
			const words = displayWords(segment.text);
			if (segment.operator) words.push(segment.operator);
			lineRows.push(...wrapDisplayWords(words, firstIndent, continuationIndent, max));
		}
		for (let index = 0; index < lineRows.length - 1; index++) {
			const operator = lineRows[index]!.trim();
			if (!/^(?:&&|\|\||\||\|&|;)$/.test(operator)) continue;
			const indent = lineRows[index]!.match(/^\s*/)?.[0] ?? "";
			const merged = `${indent}${operator} ${lineRows[index + 1]!.trimStart()}`;
			if (visibleWidth(merged) > max) continue;
			lineRows.splice(index, 2, merged);
			index -= 1;
		}
		output.push(...lineRows);
	}
	return output.length > 0 ? output : [""];
}
