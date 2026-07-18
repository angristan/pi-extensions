/**
 * core — the compact 2-line tool block builder plus shared fitting/reasoning
 * helpers. Pure library: no `pi.*` calls, no factory.
 *
 * This is the glue layer: it pulls shell highlighting (shell.ts) and diff
 * rendering (diff.ts) in to assemble a full tool block, and re-exports the
 * primitives the restylers (file-tools, bash) and sibling extensions
 * (background-jobs, web-search) consume.
 */

import { basename, dirname } from "node:path";
import { Container, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
import { formatShellCommandForDisplay, highlightShellCommand, highlightedShellLine } from "./shell.js";
import { colorizeDiff, diffPalette, WidthAwareLines } from "./diff.js";

// Re-export so restylers import everything from one place (./core.js).
export { Container, diffPalette, WidthAwareLines, colorizeDiff, formatShellCommandForDisplay, highlightShellCommand, highlightedShellLine };
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
	const timedStatusIndex = line.lastIndexOf(`${DIM}in${RESET} `);
	const separatorIndex = timedStatusIndex >= 0
		? timedStatusIndex
		: Math.max(line.lastIndexOf("·"), line.lastIndexOf("→"));
	if (separatorIndex < 0) return truncateToWidth(line, max, "…");

	const tail = line.slice(separatorIndex);
	const tailWidth = visibleWidth(tail);
	if (tailWidth >= max) return truncateToWidth(tail, max, "…");
	const head = line.slice(0, separatorIndex).trimEnd();
	return `${truncateToWidth(head, max - tailWidth - 1, "…")} ${tail}`;
}

const COMMAND_OUTPUT_PREFIX = "  │ ";

interface CommandOutputOptions {
	maxRows?: number;
	emptyText?: string;
	forceOmission?: boolean;
	omissionText?: (omittedRows: number) => string;
}

/** Render shell output with the same dim gutter and tail-first collapse everywhere. */
export function renderCommandOutput(text: string, width: number, options: CommandOutputOptions = {}): string[] {
	const max = Math.max(1, width);
	const bodyWidth = Math.max(1, max - COMMAND_OUTPUT_PREFIX.length);
	const line = (content: string) => `${DIM}${COMMAND_OUTPUT_PREFIX}${content}${RESET}`;
	const normalized = text.replace(/\t/g, "   ").replace(/\s+$/, "");
	let rows = normalized.trim()
		? normalized.split("\n").flatMap((row) => wrapTextWithAnsi(row, bodyWidth))
		: [options.emptyText ?? "(no output)"];
	const maxRows = options.maxRows === undefined ? undefined : Math.max(1, options.maxRows);
	if (maxRows !== undefined && maxRows === 1) return [line(rows.at(-1) ?? "")];

	const overflow = maxRows !== undefined && rows.length > maxRows;
	if (overflow || options.forceOmission) {
		const visibleRows = maxRows === undefined ? rows.length : Math.max(0, maxRows - 1);
		const omittedRows = overflow ? rows.length - visibleRows : 0;
		const marker = options.omissionText?.(omittedRows)
			?? `… +${omittedRows} earlier lines (Ctrl+O for full output)`;
		rows = [marker, ...rows.slice(-visibleRows)];
	}
	return rows.map(line);
}

function readRangeSuffix(args: Record<string, unknown>): string {
	const offset = Number.isInteger(args.offset) ? args.offset as number : undefined;
	const limit = Number.isInteger(args.limit) ? args.limit as number : undefined;
	if (offset !== undefined && limit !== undefined) return ` lines ${offset}-${offset + limit - 1}`;
	if (offset !== undefined) return ` from line ${offset}`;
	if (limit !== undefined) return ` first ${limit} lines`;
	return "";
}

function fg(theme: any, color: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
}

function mutationPathParts(path: string, theme?: any, cwd = process.cwd()): { file: string; location?: string } {
	const file = hyperlinkPath(`${CYAN}${basename(path)}${RESET}`, path, cwd);
	const directory = dirname(path);
	if (!directory || directory === ".") return { file };
	const displayDirectory = shortPath(directory);
	const suffix = displayDirectory.endsWith("/") ? "" : "/";
	return {
		file,
		location: `${fg(theme, "dim", "in ")}${hyperlinkPath(`${displayDirectory}${suffix}`, directory, cwd)}`,
	};
}

/** Human-readable, one-line call detail; paths use `~` like display paths. */
function argDetail(name: string, args: Record<string, unknown>, theme?: any, cwd = process.cwd()): string {
	if (name === "bash" && typeof args.command === "string") return highlightShellCommand(args.command, theme);
	if ((name === "grep" || name === "find") && typeof args.pattern === "string") {
		const path = typeof args.path === "string"
			? hyperlinkPath(shortPath(args.path), args.path, cwd)
			: undefined;
		return oneLine(path ? `${args.pattern} in ${path}` : String(args.pattern));
	}
	if (typeof args.path === "string") {
		const path = hyperlinkPath(shortPath(args.path), args.path, cwd);
		return oneLine(name === "read" ? `${path}${readRangeSuffix(args)}` : path);
	}
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
	if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

/**
 * Partial (in-progress) summary: elapsed plus streaming progress so the row
 * shows movement instead of a bare `12s`. Write streams its line count from
 * the partial `content`; edit streams its patch count from the partial
 * `edits` array. Falls back to elapsed-only when args haven't arrived yet.
 */
function partialSummary(name: string, args: Record<string, unknown>, elapsedMs: number): string {
	const elapsed = formatElapsed(elapsedMs);
	if (name === "write" && typeof args.content === "string") {
		const lines = args.content.length === 0
			? 0
			: (args.content.match(/\n/g)?.length ?? 0) + (args.content.endsWith("\n") ? 0 : 1);
		return `${MAGENTA}${lines}${RESET} ${lines === 1 ? "line" : "lines"} · ${elapsed}`;
	}
	if (name === "edit" && Array.isArray(args.edits)) {
		const count = args.edits.length;
		return `${MAGENTA}${count}${RESET} ${count === 1 ? "patch" : "patches"} · ${elapsed}`;
	}
	if (name === "bash") return elapsed;
	return elapsed;
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
	if (name === "bash") {
		const m = text.match(/(?:command exited with code|exit code:?)\s*(\d+)/i);
		const exit = m ? Number(m[1]) : null;
		// The error result contains the command's complete output. Keep that output
		// below the command instead of promoting its first line into the headline.
		const failed = isError || (exit !== null && exit !== 0);
		const status = failed
			? `${RED}✗${exit === null ? "" : ` exit ${exit}`}${RESET}`
			: `${GREEN}✓${RESET}`;
		return `${DIM}in${RESET} ${formatElapsed(elapsedMs)} ${status}`;
	}
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

/** Kept compact because this text is repeated in every restyled tool schema. */
export const REASONING_DESCRIPTION = "≤8-word present-tense intent phrase: why needed, not what it does. No period. Emit first.";

/** Clone a JSON-schema params object and inject a REQUIRED, first `reasoning` prop. */
export function withReasoning(parameters: any): any {
	const reasoning = {
		type: "string",
		description: REASONING_DESCRIPTION,
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
	opts: { isError?: boolean; isPartial?: boolean; expanded?: boolean; elapsedMs?: number; theme?: any; cwd?: string } = {},
): string[] {
	const { isError = false, isPartial = false, expanded = false, elapsedMs = 0, theme, cwd = process.cwd() } = opts;
	const { reasoning, rest } = stripReasoning(args ?? {});

	const mark = isPartial
		? `${MAGENTA}•${RESET}`
		: isError
			? `${RED}•${RESET}`
			: `${GREEN}•${RESET}`;
	// During partial, show progress info alongside elapsed so the row isn't a bare
	// `12s`: write streams its line count, edit streams its patch count.
	const summary = isPartial
		? partialSummary(name, rest, elapsedMs)
		: summarize(name, result, isError, rest, elapsedMs);

	const verb = toolVerb(name, isPartial);
	const detail = argDetail(name, rest, theme, cwd);
	const hasDetail = Boolean(detail);
	// Reasoning is the informative part — bold it so it's the emphasis, but keep
	// it default-colored (accent was too loud). The verb stays plain text.
	const headline = oneLine(reasoning);
	// Reasoning in the theme's accent tone: distinct from every syntax token
	// (red/green/blue/yellow) and from default text, so it never blends with the
	// command. On gruvbox this is the signature purple.
	// During a partial before reasoning has streamed in, show a dim `…`
	// placeholder so the headline row reads as pending rather than empty.
	const headlineText = headline
		? (typeof theme?.fg === "function" ? theme.fg("accent", headline) : `${headline}`)
		: (isPartial ? (typeof theme?.fg === "function" ? theme.fg("dim", "…") : `${DIM}…${RESET}`) : "");
	// Command colors are lightly dimmed via dimTheme (gentle HSL lightness
	// shift) so they recede slightly from full-bright, but stay clearly brighter
	// than the DIM'd output below — a middle tier between command and output.
	// bash moves its result summary (✓ 12s / elapsed / ✗ exit N) onto the
	// headline row after the reasoning, so the branch line becomes just the
	// command. Mutation tools use a path-first headline and reserve the branch
	// row for the containing directory. Other tools keep their summary beside
	// their detail on the branch row.
	const mutationUsesHeadlinePath = (name === "edit" || name === "write") && typeof rest.path === "string";
	let lines: string[];
	if (mutationUsesHeadlinePath) {
		const path = mutationPathParts(rest.path as string, theme, cwd);
		const intent = headlineText ? ` ${fg(theme, "dim", "to")} ${headlineText}` : "";
		const summarySuffix = summary ? ` ${fg(theme, "dim", "·")} ${summary}` : "";
		lines = [`${LEAD}${mark} ${verb} ${path.file}${intent}${summarySuffix}`];
		if (path.location) lines.push(`${BRANCH}${path.location}`);
	} else {
		const bashMovesSummary = name === "bash";
		const headlineSuffix = bashMovesSummary && summary ? ` ${summary}` : "";
		const metadata = bashMovesSummary
			? (hasDetail ? detail : "")
			: (hasDetail ? `${detail} · ${summary}` : summary);
		lines = [
			`${LEAD}${mark} ${verb}${headlineText ? ` ${headlineText}` : ""}${headlineSuffix}`,
		];
		if (metadata) lines.push(`${BRANCH}${metadata}`);
	}
	const diff = result?.details?.diff as string | undefined;
	const showsInlineDiff = !isPartial
		&& !isError
		&& (name === "edit" || name === "write")
		&& Boolean(diff?.trim());
	if (showsInlineDiff) {
		const path = typeof rest.path === "string" ? rest.path : undefined;
		lines.push(...colorizeDiff(diff!.replace(/\s+$/, ""), path, theme).map((line) => `${INDENT}${line}`));
	}

	// A write expansion still usefully reveals unchanged content omitted by a
	// focused diff. Diffs from empty files already show every written line, so
	// appending the complete content would render a duplicate uncolored copy.
	const diffAlreadyShowsFullWrite = name === "write"
		&& showsInlineDiff
		&& result?.details?.diffCoversFullContent === true;
	// An edit expansion would only repeat the structured diff already shown.
	if (expanded && !isPartial && !(name === "edit" && showsInlineDiff) && !diffAlreadyShowsFullWrite) {
		lines.push(...expandedLines(name, rest, result, theme));
	}
	return lines;
}
