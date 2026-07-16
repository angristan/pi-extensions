/**
 * core — the compact 2-line tool block builder plus shared fitting/reasoning
 * helpers. Pure library: no `pi.*` calls, no factory.
 *
 * This is the glue layer: it pulls shell highlighting (shell.ts) and diff
 * rendering (diff.ts) in to assemble a full tool block, and re-exports the
 * primitives the restylers (file-tools, bash) and sibling extensions
 * (background-jobs, mistral-web-search) consume.
 */

import { Container, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { hyperlinkPath } from "../hyperlinks/index.js";
import {
	BOLD,
	CYAN,
	DIM,
	GREEN,
	MAGENTA,
	RED,
	RESET,
	nonEmptyLineCount,
	shortPath,
} from "./render.js";
import { highlightShellCommand, highlightedShellLine } from "./shell.js";
import { colorizeDiff, diffPalette, WidthAwareLines } from "./diff.js";

// Re-export so restylers import everything from one place (./core.js).
export { Container, diffPalette, WidthAwareLines, colorizeDiff, highlightShellCommand, highlightedShellLine };
export type { WidthAwareLines as WidthAwareLinesType } from "./diff.js";

// Match the transcript hierarchy directly at the transcript margin.
const LEAD = "";
const BRANCH = `${LEAD}  └ `;
/** Hanging indent for expanded continuation lines below the detail row. */
const INDENT = `${LEAD}    `;

/** Collapse whitespace/newlines to one line (width-based truncation happens at render). */
function oneLine(s: string | undefined): string {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Fit a rendered line while preserving result metadata after the final `·`. */
export function fitToolLine(line: string, width: number): string {
	const max = Math.max(1, width);
	if (visibleWidth(line) <= max) return line;
	const separatorIndex = Math.max(line.lastIndexOf("·"), line.lastIndexOf("→"));
	if (separatorIndex < 0) return truncateToWidth(line, max, "…");

	const tail = line.slice(separatorIndex);
	const tailWidth = visibleWidth(tail);
	if (tailWidth >= max) return truncateToWidth(tail, max, "…");
	const head = line.slice(0, separatorIndex).trimEnd();
	return `${truncateToWidth(head, max - tailWidth - 1, "…")} ${tail}`;
}

/** Human-readable, one-line call detail; paths use `~` like display paths. */
function argDetail(name: string, args: Record<string, unknown>, theme?: any): string {
	if (name === "bash" && typeof args.command === "string") return highlightShellCommand(args.command, theme);
	if ((name === "grep" || name === "find") && typeof args.pattern === "string") {
		const path = typeof args.path === "string"
			? hyperlinkPath(shortPath(args.path), args.path, cwd)
			: undefined;
		return oneLine(path ? `${args.pattern} in ${path}` : String(args.pattern));
	}
	if (typeof args.path === "string") return oneLine(hyperlinkPath(shortPath(args.path), args.path, cwd));
	if (typeof args.name === "string") return oneLine(args.name);
	return "";
}

/** Present/past-tense semantic labels, modeled after transcript cells. */
function toolVerb(name: string, isPartial: boolean): string {
	const verbs: Record<string, [running: string, complete: string]> = {
		read: ["Reading", "Read"],
		write: ["Writing", "Wrote"],
		edit: ["Editing", "Edited"],
		bash: ["Running", "Ran"],
		grep: ["Searching", "Searched"],
		find: ["Finding", "Found"],
		ls: ["Listing", "Listed"],
	};
	const pair = verbs[name] ?? ["Using", "Used"];
	return pair[isPartial ? 0 : 1];
}

/** Compact elapsed time for an in-progress tool. */
export function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1000) return "<1s";
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Pull the first text block out of a tool result / partial (shape varies). */
function textFromResult(r: any): string {
	const content = r?.content ?? r?.partialResult?.content;
	if (Array.isArray(content)) {
		const c = content.find((x: any) => x?.type === "text");
		if (c?.text) return c.text;
	}
	if (typeof r?.output === "string") return r.output;
	return "";
}

/** Colored result summary from a finished tool result. */
function summarize(
	name: string,
	result: any,
	isError: boolean,
	args: Record<string, unknown> = {},
	elapsedMs = 0,
): string {
	const text = textFromResult(result);
	if (isError) return `${RED}${text.split("\n")[0] || "error"}${RESET}`;
	if (name === "read") return `${GREEN}${text.split("\n").length} lines${RESET}`;
	if (name === "write") {
		if (typeof args.content === "string" && !args.content.includes("\0")) {
			const lines = args.content.length === 0
				? 0
				: (args.content.match(/\n/g)?.length ?? 0) + (args.content.endsWith("\n") ? 0 : 1);
			return `${GREEN}${lines}${RESET} ${lines === 1 ? "line" : "lines"}`;
		}
		const bytes = text.match(/wrote (\d+) bytes/i)?.[1];
		return bytes ? `${GREEN}${bytes}b${RESET}` : `${GREEN}written${RESET}`;
	}
	if (name === "edit") {
		const diff = result?.details?.diff as string | undefined;
		if (!diff) return `${GREEN}applied${RESET}`;
		let add = 0;
		let del = 0;
		for (const l of diff.split("\n")) {
			if (l.startsWith("+") && !l.startsWith("+++")) add++;
			if (l.startsWith("-") && !l.startsWith("---")) del++;
		}
		return `(${GREEN}+${add}${RESET} ${RED}-${del}${RESET})`;
	}
	if (name === "bash") {
		const m = text.match(/exit code: (\d+)/);
		const exit = m ? Number(m[1]) : null;
		const status = exit && exit !== 0 ? `${RED}exit ${exit}` : `${GREEN}done`;
		return `${status}${RESET} in ${formatElapsed(elapsedMs)}`;
	}
	if (name === "grep") {
		if (/^No matches found/.test(text.trim())) return "0 matches in 0 files";
		// Count only true match lines (path:lineno:...), not context (path-lineno-...) or -- separators.
		const matchLines = text.split("\n").map((line) => ({ line, match: line.match(/^(.+):\d+:/) })).filter((entry) => entry.match);
		const count = matchLines.length || nonEmptyLineCount(text);
		const files = new Set(matchLines.map((entry) => entry.match?.[1])).size;
		const matchLabel = count === 1 ? "match" : "matches";
		const fileLabel = files === 1 ? "file" : "files";
		return `${GREEN}${count} ${matchLabel}${RESET} in ${CYAN}${files} ${fileLabel}${RESET}`;
	}
	const count = nonEmptyLineCount(text);
	const noun = name === "find" ? "files" : name === "ls" ? "entries" : "results";
	return `${count} ${noun}`;
}

/** Clone a JSON-schema params object and inject a REQUIRED, first `reasoning` prop. */
export function withReasoning(parameters: any): any {
	const reasoning = {
		type: "string",
		description:
			"Short phrase (≤12 words) stating the GOAL behind this call — the why-in-context, not the what. Do NOT restate the file, path, or command (those are already shown next to it); instead give the intent or what you expect to find/confirm. Present-tense, no period. E.g. \"confirm executionStarted is a timestamp\", \"fix the map leak from review\", \"retry match after previous miss\".",
	};
	const properties = { reasoning, ...(parameters?.properties ?? {}) };
	const required = Array.from(new Set(["reasoning", ...(parameters?.required ?? [])]));
	return { ...parameters, properties, required };
}

/** Strip our injected `reasoning` before delegating to the real tool. */
export function stripReasoning(params: any): { reasoning?: string; rest: any } {
	if (!params || typeof params !== "object") return { rest: params };
	const { reasoning, ...rest } = params;
	return { reasoning: typeof reasoning === "string" ? reasoning : undefined, rest };
}

/**
 * Build the expanded (C-o) continuation lines for a settled tool result:
 *   - bash: the full multi-line command input, then its output
 *   - edit/write: the colored line-numbered diff when present
 *   - otherwise: the raw result text
 * Each line is prefixed with the hanging INDENT.
 */
function expandedLines(name: string, args: Record<string, unknown>, result: any, theme?: any): string[] {
	const out: string[] = [];

	// bash: show the full command (collapsed line 2 is truncated to one line).
	if (name === "bash" && typeof args.command === "string") {
		const cmdLines = args.command.replace(/\t/g, "   ").replace(/\s+$/, "").split("\n");
		cmdLines.forEach((line, index) => {
			const prefix = index === 0 ? `${CYAN}$ ${RESET}` : "  ";
			out.push(`${INDENT}${prefix}${highlightedShellLine(line, theme)}`);
		});
	}

	// Whole-file writes do not provide a useful diff. Show the actual written
	// content instead of repeating the generic "Successfully wrote..." result.
	if (name === "write" && typeof args.content === "string") {
		if (args.content.length === 0) {
			out.push(`${INDENT}(empty file)`);
			return out;
		}
		const splitLines = args.content.split("\n");
		const contentLines = args.content.endsWith("\n") ? splitLines.slice(0, -1) : splitLines;
		const lineNumberWidth = String(contentLines.length).length;
		contentLines.forEach((line, index) => {
			const lineNumber = String(index + 1).padStart(lineNumberWidth, " ");
			out.push(`${INDENT}${lineNumber} ${line}`);
		});
		return out;
	}

	// Prefer the structured diff over the generic "Successfully replaced..." text.
	const diff = result?.details?.diff as string | undefined;
	if (diff && diff.trim()) {
		const path = typeof args.path === "string" ? args.path : undefined;
		for (const dl of colorizeDiff(diff.replace(/\s+$/, ""), path, theme)) out.push(`${INDENT}${dl}`);
		return out;
	}

	const text = textFromResult(result).replace(/\s+$/, "");
	if (text) for (const raw of text.split("\n")) out.push(`${INDENT}${raw}`);
	return out;
}

/**
 * Build the rendered lines for one settled tool call. Shared by the live
 * renderResult and the demo generator so the demo shows REAL output, never
 * hand-typed ANSI. `args` includes the model's `reasoning` (stripped here).
 */
export function buildToolBlock(
	name: string,
	args: Record<string, unknown>,
	result: any,
	opts: { isError?: boolean; isPartial?: boolean; expanded?: boolean; elapsedMs?: number; theme?: any } = {},
): string[] {
	const { isError = false, isPartial = false, expanded = false, elapsedMs = 0, theme } = opts;
	const { reasoning, rest } = stripReasoning(args ?? {});

	const mark = isPartial
		? `${MAGENTA}•${RESET}`
		: isError
			? `${RED}•${RESET}`
			: `${GREEN}•${RESET}`;
	const summary = isPartial
		? formatElapsed(elapsedMs)
		: summarize(name, result, isError, rest, elapsedMs);

	const verb = toolVerb(name, isPartial);
	const detail = argDetail(name, rest, theme);
	const hasDetail = Boolean(detail);
	// Subtle dim on the reasoning headline so the verb reads as the emphasis and
	// the reason recedes slightly into the background, matching the cells.
	const headline = oneLine(reasoning);
	const headlineTone = headline ? `${DIM}${headline}${RESET}` : "";
	const metadata = hasDetail
		? `${detail} · ${summary}`
		: summary;
	const lines: string[] = [
		`${LEAD}${mark} ${BOLD}${verb}${RESET}${headlineTone ? ` ${headlineTone}` : ""}`,
		`${BRANCH}${metadata}`,
	];
	const diff = result?.details?.diff as string | undefined;
	const showsInlineDiff = !isPartial
		&& !isError
		&& (name === "edit" || name === "write")
		&& Boolean(diff?.trim());
	if (showsInlineDiff) {
		const path = typeof rest.path === "string" ? rest.path : undefined;
		lines.push(...colorizeDiff(diff!.replace(/\s+$/, ""), path, theme).map((line) => `${INDENT}${line}`));
	}

	// A write expansion still usefully reveals the complete written content.
	// An edit expansion would only repeat the structured diff already shown.
	if (expanded && !isPartial && !(name === "edit" && showsInlineDiff)) {
		lines.push(...expandedLines(name, rest, result, theme));
	}
	return lines;
}

const cwd = process.cwd();
