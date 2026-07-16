/**
 * shell — bash/sh syntax highlighting. A small tokenizer that colors keywords,
 * commands, operators, variables, strings, comments, and numbers, theme-aware
 * with raw-ANSI fallbacks so it renders even without a pi theme.
 *
 * Used by the `bash` restyler (command detail on line 2 + expanded view) and by
 * core's argDetail/expandedLines. Depends only on the palette (render.ts).
 */

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
