/**
 * bash — restyles pi's `bash` tool with a reason-first headline, a bordered and
 * syntax-highlighted command, plus bounded head/tail output (expandable via C-o).
 *
 * Same pattern as file-tools: re-register `bash` under its native name with
 * `renderShell: "self"`, inject a required `reasoning` param, delegate
 * `execute` to the real built-in. Owns the CommandComponent (width-cached,
 * volatile partials) separate from the file tools' WidthAwareLines.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createBashToolDefinition, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getBackgroundTerminalService, type BackgroundTerminalService } from "../background-jobs/service.js";
import { renderCodeBox } from "../code-blocks/index.js";
import { buildToolBlock, fitToolLine, formatShellCommandForDisplay, highlightedShellLine, withReasoning } from "./core.js";

const OUTPUT_ROWS = 5;
const COMMAND_ROWS = 8;
const EXPANDED_OUTPUT_BYTES = 256 * 1024;
const COLLAPSED_OUTPUT_BYTES = 4 * 1024;
const COMMAND_INDENT = "  ";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
// The command box and output bar share the same left edge, keeping input and
// output visually connected while preserving the blockquote-style output.
const BAR = "│";
const OUTPUT_PREFIX = `${COMMAND_INDENT}${BAR} `;
function barLine(text: string): string {
	return `${DIM}${OUTPUT_PREFIX}${text}${RESET}`;
}
const RENDER_STATS_KEY = Symbol.for("pi.renderer-cache.stats");

interface RendererCacheStats {
	renderCalls: number;
	cacheHits: number;
	cacheMisses: number;
	volatileRenders: number;
	invalidations: number;
}

function commandRendererStats(): RendererCacheStats {
	const root = globalThis as typeof globalThis & {
		[RENDER_STATS_KEY]?: Record<string, RendererCacheStats>;
	};
	const registry = root[RENDER_STATS_KEY] ??= {};
	return registry["better-native-pi:bash"] ??= {
		renderCalls: 0,
		cacheHits: 0,
		cacheMisses: 0,
		volatileRenders: 0,
		invalidations: 0,
	};
}

const rendererStats = commandRendererStats();

function stripReasoning(params: any): { reasoning?: string; rest: any } {
	if (!params || typeof params !== "object") return { rest: params };
	const { reasoning, ...rest } = params;
	return { reasoning: typeof reasoning === "string" ? reasoning : undefined, rest };
}

function withTerminalParameters(parameters: any): any {
	const base = withReasoning(parameters) as any;
	return {
		...base,
		properties: {
			...base.properties,
			timeout: { type: "integer", minimum: 1, maximum: 86_400, description: "Optional hard timeout from 1 to 86400 seconds" },
			cwd: { type: "string", description: "Working directory, relative to the current project unless absolute" },
			tty: { type: "boolean", description: "Allocate a PTY for prompts, REPLs, and control characters. Non-tty commands spawn with stdin closed (EOF) so a command that reads stdin with no input exits instead of hanging; use tty=true for commands you need to feed via terminal_write.", default: false },
			"yield-time_ms": { type: "integer", minimum: 250, maximum: 30_000, description: "Wait before yielding a terminal ID (default 10000 ms)" },
			max_output_tokens: { type: "integer", minimum: 1, description: "Output byte budget in tokens (~4 bytes/token). Defaults to 10000; larger requests cap at 1 MiB." },
		},
	};
}

function resultText(result: any): string {
	const content = result?.content ?? result?.partialResult?.content;
	if (Array.isArray(content)) {
		return content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
	}
	return typeof result?.output === "string" ? result.output : "";
}

function withoutCommand(args: any): any {
	if (!args || typeof args !== "object") return args;
	const { command: _command, ...rest } = args;
	return rest;
}

function renderedCommand(command: string, width: number, expanded: boolean, theme: any): string[] {
	const max = Math.max(1, width);
	const normalized = command.replace(/\t/g, "   ").replace(/\s+$/, "");
	const boxWidth = Math.max(1, max - COMMAND_INDENT.length);
	const formatted = formatShellCommandForDisplay(normalized, Math.max(1, boxWidth - 4));
	let markdownTheme: any;
	try {
		markdownTheme = getMarkdownTheme();
		markdownTheme.codeBlockBorder("");
	} catch {
		// Render tests and early extension discovery can run before Pi initializes
		// its global theme proxy. The callback theme still provides safe colors.
		markdownTheme = {
			codeBlock: (text: string) => text,
			codeBlockBorder: (text: string) => typeof theme?.fg === "function" ? theme.fg("borderMuted", text) : text,
		};
	}
	const commandTheme = {
		...markdownTheme,
		highlightCode: (code: string) => code.split("\n").map((line) => highlightedShellLine(line, theme)),
	};
	return renderCodeBox(formatted.join("\n"), "bash", boxWidth, commandTheme, {
		maxRows: expanded ? undefined : COMMAND_ROWS,
		renderOmission: (omitted, innerWidth) => theme.fg(
			"dim",
			truncateToWidth(`… +${omitted} lines (Ctrl+O)`, innerWidth, "…"),
		),
	})
		.map((line) => `${COMMAND_INDENT}${line}`)
		.map((line) => fitToolLine(line, max));
}

function wrappedOutput(text: string, width: number): string[] {
	const bodyWidth = Math.max(1, width - OUTPUT_PREFIX.length);
	const rows = text.replace(/\t/g, "   ").replace(/\s+$/, "").split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
	return rows.map((row) => barLine(row));
}

function boundedRows(rows: string[]): string[] {
	if (rows.length <= OUTPUT_ROWS) return rows;
	const tailRows = OUTPUT_ROWS - 1;
	const omitted = rows.length - tailRows;
	return [
		barLine(`… +${omitted} earlier lines (Ctrl+O for full output)`),
		...rows.slice(-tailRows),
	];
}

function terminalStatusColor(status: string): string {
	if (status === "running") return "accent";
	if (status === "stopping" || status === "timed_out") return "warning";
	if (status === "completed") return "success";
	if (status === "killed") return "muted";
	return "error";
}

function terminalStatusSymbol(status: string): string {
	if (status === "running") return "●";
	if (status === "stopping") return "◌";
	if (status === "completed") return "✓";
	if (status === "timed_out") return "◷";
	if (status === "killed") return "■";
	return "×";
}

class CommandComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly args: any,
		private readonly result: any,
		private readonly options: { partial: boolean; expanded: boolean; error: boolean; elapsedMs: number; cwd?: string },
		private readonly theme: any,
	) {}

	invalidate(): void {
		rendererStats.invalidations += 1;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		rendererStats.renderCalls += 1;
		const max = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === max) {
			rendererStats.cacheHits += 1;
			return this.cachedLines;
		}
		rendererStats.cacheMisses += 1;
		const block = buildToolBlock("bash", withoutCommand(this.args), this.result, {
			isPartial: this.options.partial,
			isError: this.options.error,
			elapsedMs: this.options.elapsedMs,
			theme: this.theme,
			cwd: this.options.cwd,
		});
		const command = typeof this.args?.command === "string"
			? renderedCommand(this.args.command, max, this.options.expanded, this.theme)
			: [];
		if (this.options.partial) {
			this.cachedLines = [...block.map((line) => fitToolLine(line, max)), ...command];
			this.cachedWidth = max;
			return this.cachedLines;
		}

		const text = resultText(this.result);
		let output = text.trim() ? wrappedOutput(text, max) : [barLine("(no output)")];
		if (!this.options.expanded) output = boundedRows(output);
		const fittedBlock = block.map((line) => fitToolLine(line, max));
		this.cachedLines = [...fittedBlock, ...command, ...output];
		this.cachedWidth = max;
		return this.cachedLines;
	}
}

class ManagedCommandComponent {
	private fallback: any;
	private expanded: boolean;
	private observedAt: number;
	private frozenView?: { details: any; output: string };
	// Width-keyed render cache, mirroring CommandComponent above. Without this,
	// every render tick re-runs sanitizeTerminalOutput (regex), wrapTextWithAnsi
	// (ICU grapheme segmentation), and visibleWidth across every line — for
	// every background-job card in the transcript. A long session with many
	// such cards then burns CPU in the render path even when idle.
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly args: any,
		result: any,
		expanded: boolean,
		private readonly theme: any,
		private readonly cwd: string | undefined,
		private readonly service: BackgroundTerminalService,
	) {
		this.fallback = result?.details ?? {};
		this.expanded = expanded;
		this.observedAt = Number.isFinite(this.fallback.observedAt) ? this.fallback.observedAt : Date.now();
	}

	update(result: any, expanded: boolean): void {
		const next = result?.details ?? this.fallback;
		const changed = this.revision(next) !== this.revision(this.fallback);
		const expansionChanged = this.expanded !== expanded;
		this.fallback = next;
		if (changed || expansionChanged) this.frozenView = undefined;
		if (Number.isFinite(next?.observedAt)) this.observedAt = next.observedAt;
		// Partial updates and expansion changes are the only reasons to recompute
		// this transcript row. Once a command yields, the card becomes an immutable
		// snapshot and live output moves to the explicitly opened /ps overlay.
		if (changed || expansionChanged) this.invalidate();
		this.expanded = expanded;
	}

	private view(): { details: any; output: string } {
		const active = this.fallback.status === "running" || this.fallback.status === "stopping";
		if (active && this.fallback.backgrounded) {
			// Resolve once so resumed cards whose process no longer exists can settle
			// to "killed"; live cards then keep that snapshot immutable.
			this.frozenView ??= this.service.getView(
				this.fallback.id,
				this.fallback,
				this.expanded ? EXPANDED_OUTPUT_BYTES : COLLAPSED_OUTPUT_BYTES,
			);
			return this.frozenView;
		}
		return this.service.getView(
			this.fallback.id,
			this.fallback,
			this.expanded ? EXPANDED_OUTPUT_BYTES : COLLAPSED_OUTPUT_BYTES,
		);
	}

	private revision(details: any): string {
		return [
			details.status,
			details.backgrounded,
			details.outputCursor,
			details.endedAt,
			details.exitCode,
			details.signal,
			details.stdoutOmittedBytes,
			details.stderrOmittedBytes,
		].join(":");
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === max) return this.cachedLines;
		const view = this.view();
		const details = view.details;
		const status = details.status ?? "failed";
		const active = status === "running" || status === "stopping";
		// Every card is width-cached. Foreground output invalidates through Pi's
		// partial-result updates; yielded cards never mutate behind the viewport.
		const elapsedMs = Math.max(0, (details.endedAt ?? this.observedAt) - (details.startedAt ?? this.observedAt));
		const failed = status === "failed" || status === "killed" || status === "timed_out";
		const summaryText = details.exitCode === undefined ? status : `Command exited with code ${details.exitCode}`;
		const summaryResult = { content: [{ type: "text", text: summaryText }] };
		const block = buildToolBlock("bash", withoutCommand(this.args), summaryResult, {
			isPartial: active,
			isError: failed,
			elapsedMs,
			theme: this.theme,
			cwd: this.cwd,
		}).map((line) => fitToolLine(line, max));
		const command = typeof this.args?.command === "string"
			? renderedCommand(this.args.command, max, this.expanded, this.theme)
			: [];
		const text = view.output.replace(/\s+$/, "");
		let output = text ? wrappedOutput(text, max) : [barLine(active ? "(waiting for output)" : "(no output)")];
		if (!this.expanded) output = boundedRows(output);
		if (!details.backgrounded) {
			const result = [...block, ...command, ...output];
			this.cachedLines = result;
			this.cachedWidth = max;
			return result;
		}
		const color = terminalStatusColor(status);
		const metadata = [details.id, status, details.tty ? "tty" : undefined, active ? "/ps" : undefined].filter(Boolean).join(" · ");
		const footer = fitToolLine(`  └ ${this.theme.fg(color, terminalStatusSymbol(status))} ${this.theme.fg("dim", metadata)}`, max);
		const result = [...block, ...command, ...output, footer];
		this.cachedLines = result;
		this.cachedWidth = max;
		return result;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {}
}

export default function bash(pi: ExtensionAPI) {
	const bashTool = createBashToolDefinition(process.cwd());
	const terminalService = getBackgroundTerminalService();
	const terminalEnabled = Boolean(terminalService);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: terminalEnabled
			? `${bashTool.description} Quick commands return normally; long-running commands yield a managed terminal ID. Set tty=true for prompts and REPLs.`
			: bashTool.description,
		promptSnippet: bashTool.promptSnippet,
		parameters: terminalEnabled ? withTerminalParameters(bashTool.parameters) : withReasoning(bashTool.parameters),
		promptGuidelines: bashTool.promptGuidelines,
		renderShell: "self",
		execute: async (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => {
			const terminal = getBackgroundTerminalService();
			if (terminal) return terminal.execute(id, params, signal, onUpdate, ctx);
			const { rest } = stripReasoning(params);
			return createBashTool(ctx.cwd).execute(id, rest, signal, onUpdate);
		},
		renderCall: (args: any, theme: any, context: any) => {
			if (!context?.isPartial) return new Container();
			// When the terminal service is present, execute delegates to
			// executeUnified, whose result always carries managedTerminal details.
			// renderResult mounts a ManagedCommandComponent that owns the entire card
			// (headline + command + output), so the call card would duplicate it.
			// Returning empty here avoids a one-frame double-card: renderCall runs
			// before renderResult in the same frame, so the state check alone can't
			// close the gap.
			if (getBackgroundTerminalService()) return new Container();
			context.state.startedAt ??= Date.now();
			return new CommandComponent(args, {}, {
				partial: true,
				expanded: false,
				error: false,
				elapsedMs: Date.now() - context.state.startedAt,
				cwd: context.cwd,
			}, theme);
		},
		renderResult: (result: any, options: any, theme: any, context: any) => {
			const terminal = getBackgroundTerminalService();
			// Stream partial output for managed terminals: executeUnified pushes
			// coalesced updates while the job runs. Render the live component so
			// stdout appears during the foreground yield window; once yielded, the
			// transcript card freezes and /ps owns live updates.
			if (options?.isPartial && terminal && result?.details?.managedTerminal) {
				let component = context.state.managedCommand as ManagedCommandComponent | undefined;
				if (!component) {
					component = new ManagedCommandComponent(
						context.args ?? { command: result.details.command, reasoning: result.details.description },
						result,
						Boolean(options.expanded),
						theme,
						context.cwd,
						terminal,
					);
					context.state.managedCommand = component;
				} else component.update(result, Boolean(options.expanded));
				return component;
			}
			if (options?.isPartial) return new Container();
			if (terminal && result?.details?.managedTerminal) {
				let component = context.state.managedCommand as ManagedCommandComponent | undefined;
				if (!component) {
					component = new ManagedCommandComponent(
						context.args ?? { command: result.details.command, reasoning: result.details.description },
						result,
						Boolean(options.expanded),
						theme,
						context.cwd,
						terminal,
					);
					context.state.managedCommand = component;
				} else component.update(result, Boolean(options.expanded));
				return component;
			}
			context.state.startedAt ??= Date.now();
			context.state.endedAt ??= Date.now();
			return new CommandComponent(context.args ?? {}, result, {
				partial: false,
				expanded: options?.expanded ?? false,
				error: context?.isError ?? result?.isError ?? false,
				elapsedMs: context.state.endedAt - context.state.startedAt,
				cwd: context.cwd,
			}, theme);
		},
	});
}
