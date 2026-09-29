/**
 * codemode — restyles Pi's built-in `codemode` tool into the same block as
 * bash: a status headline, the script in the bordered code box, one branch row
 * per nested tool call, and the script output in the dim `│` gutter.
 *
 *   • Ran script · 3 calls in 120ms ✓
 *     ╭ javascript ──────────────────╮
 *     │ const rows = await Promise…  │
 *     ╰──────────────────────────────╯
 *     └ bash collect repo stats ×3 ✓
 *     │ | Repo | Commits | …
 *
 * Only the renderers change. The definition comes from Pi's own
 * `createCodemodeExtension()`, so execution, loadout hooks, and settings stay
 * Pi's. Registration waits for `session_start`: Pi drops a replaceable built-in
 * extension, with a startup warning, when another extension registers the same
 * tool during load. A later registration keeps the built-in loaded and shadows
 * its definition, because Pi resolves tool names in extension order and
 * built-ins load last.
 */

import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderCodeBox } from "../code-blocks/index.js";
import { toolCodeBoxTheme } from "./bash.js";
import { fitToolLine, formatElapsed, normalizeToolReasoning, renderCommandOutput } from "./core.js";
import { DIM, GREEN, MAGENTA, RED, RESET } from "./render.js";

const TOOL_NAME = "codemode";
const SCRIPT_ROWS = 8;
const CALL_ROWS = 6;
const OUTPUT_ROWS = 5;
const INDENT = "  ";
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n/;

/** Nested call record in `CodemodeToolDetails.calls` (Pi 0.99). */
export interface CodemodeCall {
	name: string;
	/** Compact JSON of the arguments, truncated by Pi for display. */
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}

export interface CodemodeView {
	code: string;
	result?: { content?: any[]; details?: { calls?: CodemodeCall[]; fullOutputPath?: string } };
	partial: boolean;
	error: boolean;
	expanded: boolean;
	/** Elapsed time captured at the last update; used only while partial. */
	elapsedMs: number;
}

function fg(theme: any, color: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
}

/** Nested calls keep their `reasoning` argument; show it like other tool rows. */
function callLabel(call: CodemodeCall): string {
	const match = call.args.match(/"reasoning":"((?:[^"\\]|\\.)*)"/);
	if (match) {
		try {
			return normalizeToolReasoning(JSON.parse(`"${match[1]}"`));
		} catch {
			// Pi truncates long argument JSON; fall through to the raw preview.
		}
	}
	return call.args === "{}" ? "" : call.args;
}

interface CallGroup {
	name: string;
	label: string;
	calls: CodemodeCall[];
}

/** Collapse consecutive calls with the same tool and reason, e.g. a fan-out loop. */
function groupCalls(calls: readonly CodemodeCall[]): CallGroup[] {
	const groups: CallGroup[] = [];
	for (const call of calls) {
		const label = callLabel(call);
		const last = groups.at(-1);
		if (last && last.name === call.name && last.label === label) last.calls.push(call);
		else groups.push({ name: call.name, label, calls: [call] });
	}
	return groups;
}

function groupStatus(group: CallGroup): string {
	const count = (status: CodemodeCall["status"]) => group.calls.filter((call) => call.status === status).length;
	const running = count("running");
	const failed = count("error");
	const cancelled = count("cancelled");
	const parts: string[] = [];
	if (running) parts.push(`${MAGENTA}…${RESET}`);
	if (failed) parts.push(`${RED}✗${group.calls.length > 1 ? ` ${failed}` : ""}${RESET}`);
	if (cancelled) parts.push(`${DIM}⊘${RESET}`);
	if (!running && !failed && !cancelled) parts.push(`${GREEN}✓${RESET}`);
	// A single call shows its own duration; a parallel group has no single one.
	const single = group.calls.length === 1 ? group.calls[0] : undefined;
	const duration = single?.durationMs !== undefined ? `${DIM}${formatElapsed(single.durationMs)}${RESET} ` : "";
	const cost = single?.cost ? `${DIM}$${single.cost >= 0.01 ? single.cost.toFixed(2) : single.cost.toPrecision(2)}${RESET} ` : "";
	return `${duration}${cost}${parts.join(" ")}`;
}

function renderCalls(calls: readonly CodemodeCall[], width: number, expanded: boolean, theme: any): string[] {
	let groups = groupCalls(calls);
	const lines: string[] = [];
	if (!expanded && groups.length > CALL_ROWS) {
		const hidden = groups.length - (CALL_ROWS - 1);
		lines.push(fitToolLine(`${fg(theme, "dim", `  ├ … +${hidden} earlier calls (Ctrl+O)`)}`, width));
		groups = groups.slice(-(CALL_ROWS - 1));
	}
	groups.forEach((group, index) => {
		const connector = index === groups.length - 1 ? "└" : "├";
		const repeat = group.calls.length > 1 ? ` ${fg(theme, "dim", `×${group.calls.length}`)}` : "";
		const label = group.label ? ` ${group.label}` : "";
		// fitToolLine keeps the trailing status after `·` when the label is cut.
		lines.push(fitToolLine(
			`${fg(theme, "dim", `  ${connector} `)}${fg(theme, "accent", group.name)}${label}${repeat} ${fg(theme, "dim", "·")} ${groupStatus(group)}`,
			width,
		));
		if (!expanded) return;
		for (const call of group.calls) {
			if (!call.error) continue;
			for (const row of call.error.split("\n")) {
				lines.push(truncateToWidth(`${INDENT}    ${RED}${row}${RESET}`, width, "…"));
			}
		}
	});
	return lines;
}

function scriptOutput(content: readonly any[] = []): { text: string; wallSeconds?: number } {
	const texts = content.filter((item) => item?.type === "text").map((item) => String(item.text));
	const header = texts[0]?.match(SCRIPT_HEADER);
	if (!header) return { text: texts.join("\n") };
	// The header block may also carry the first output line after "Output:\n".
	const rest = [texts[0]!.slice(header[0].length), ...texts.slice(1)].filter(Boolean);
	return { text: rest.join("\n"), wallSeconds: Number(header[2]) };
}

function highlightScript(code: string): string[] {
	const highlight = (piCodingAgent as any).highlightCode;
	if (typeof highlight !== "function") return code.split("\n");
	try {
		return highlight(code, "javascript");
	} catch {
		return code.split("\n");
	}
}

function renderScript(code: string, width: number, expanded: boolean, theme: any): string[] {
	const normalized = code.replace(/\r/g, "").replace(/\t/g, "   ").replace(/\s+$/, "");
	if (!normalized) return [];
	const boxWidth = Math.max(1, width - INDENT.length);
	return renderCodeBox(normalized, "javascript", boxWidth, toolCodeBoxTheme(theme, highlightScript), {
		maxRows: expanded ? undefined : SCRIPT_ROWS,
		renderOmission: (omitted, innerWidth) => fg(theme, "dim", truncateToWidth(`… +${omitted} lines (Ctrl+O)`, innerWidth, "…")),
	}).map((line) => fitToolLine(`${INDENT}${line}`, width));
}

/** Render the whole codemode block. Pure: all live values arrive in `view`. */
export function renderCodemodeBlock(view: CodemodeView, width: number, theme: any): string[] {
	const max = Math.max(1, width);
	const calls = view.result?.details?.calls ?? [];
	const { text, wallSeconds } = scriptOutput(view.result?.content);
	const callCount = calls.length > 0 ? ` ${fg(theme, "dim", "·")} ${calls.length} ${calls.length === 1 ? "call" : "calls"}` : "";

	let headline: string;
	if (view.partial) {
		headline = `${MAGENTA}•${RESET} Running ${fg(theme, "accent", "script")}${callCount} ${fg(theme, "dim", "·")} ${formatElapsed(view.elapsedMs)}`;
	} else {
		const mark = view.error ? `${RED}•${RESET}` : `${GREEN}•${RESET}`;
		const status = view.error ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
		const time = wallSeconds === undefined ? "" : `${DIM}in${RESET} ${formatElapsed(wallSeconds * 1000)} `;
		headline = `${mark} Ran ${fg(theme, "accent", "script")}${callCount} ${time}${status}`;
	}

	const lines = [fitToolLine(headline, max), ...renderScript(view.code, max, view.expanded, theme)];
	lines.push(...renderCalls(calls, max, view.expanded, theme));
	if (view.partial) return lines;

	lines.push(...renderCommandOutput(text, max, { maxRows: view.expanded ? undefined : OUTPUT_ROWS }));
	const fullOutputPath = view.result?.details?.fullOutputPath;
	if (fullOutputPath && !view.expanded) {
		lines.push(truncateToWidth(`${DIM}  │ full output: ${fullOutputPath}${RESET}`, max, "…"));
	}
	return lines.map((line) => visibleWidth(line) <= max ? line : truncateToWidth(line, max, "…"));
}

/** Width-keyed cache over renderCodemodeBlock; updates replace the view. */
class CodemodeCard {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private view: CodemodeView, private readonly theme: any) {}

	update(view: CodemodeView): void {
		this.view = view;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = renderCodemodeBlock(this.view, width, this.theme);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

/**
 * The call slot owns the card and the result slot stays empty. Pi runs both
 * renderers on every update, call first, and renders afterwards, so the card
 * always draws the latest result without duplicating the block.
 */
function withRenderers(definition: any): any {
	const viewFor = (context: any, theme: any): CodemodeCard => {
		const state = context.state;
		state.startedAt ??= Date.now();
		const view: CodemodeView = {
			code: typeof context.args?.code === "string" ? context.args.code : "",
			result: state.result,
			partial: context.isPartial !== false,
			error: Boolean(context.isError),
			expanded: Boolean(context.expanded),
			// Captured here, never in render(): settled rows must redraw identically.
			elapsedMs: Date.now() - state.startedAt,
		};
		if (state.card) state.card.update(view);
		else state.card = new CodemodeCard(view, theme);
		return state.card;
	};
	return {
		...definition,
		renderShell: "self",
		renderCall: (_args: any, theme: any, context: any) => viewFor(context, theme),
		renderResult: (result: any, options: any, theme: any, context: any) => {
			context.state.result = result;
			viewFor({ ...context, isPartial: options?.isPartial, expanded: options?.expanded }, theme);
			return new Container();
		},
	};
}

type CreateCodemodeExtension = () => (pi: ExtensionAPI) => void;

export default function codemode(
	pi: ExtensionAPI,
	createExtension: CreateCodemodeExtension | undefined = (piCodingAgent as any).createCodemodeExtension,
) {
	let registered = false;
	pi.on("session_start", () => {
		if (registered || !createExtension) return;
		// Restyle only Pi's built-in tool. Respect `pi config` disabling it, and
		// leave a third-party codemode extension alone.
		const existing = (pi.getAllTools() as any[]).find((tool) => tool.name === TOOL_NAME);
		if (!String(existing?.sourceInfo?.path ?? "").startsWith("builtin:")) return;
		registered = true;
		const proxy = new Proxy(pi, {
			get: (target, key, receiver) => key === "registerTool"
				? (definition: any) => target.registerTool(withRenderers(definition))
				: Reflect.get(target, key, receiver),
		});
		createExtension()(proxy);
	});
}
