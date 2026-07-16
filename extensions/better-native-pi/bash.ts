/**
 * bash — restyles pi's `bash` tool into the same compact 2-line block as the
 * file tools, plus bounded head/tail output (5 rows, expandable via C-o).
 *
 * Same pattern as file-tools: re-register `bash` under its native name with
 * `renderShell: "self"`, inject a required `reasoning` param, delegate
 * `execute` to the real built-in. Owns the CommandComponent (width-cached,
 * volatile partials) separate from the file tools' WidthAwareLines.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Container, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildToolBlock, fitToolLine, withReasoning } from "./core.js";
import { wrapBranchLine } from "./diff.js";

const OUTPUT_ROWS = 5;
const INDENT = "    ";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
// Left bar prefix for bash output: the `│` sits directly under the `└` branch
// char above it (both at column 3), framing the output as one blockquote-style
// group instead of a bare indented blob. Same 4-col visual budget as INDENT,
// so wrap width is unchanged.
const BAR = "│";
function barLine(text: string): string {
	return `${DIM}  ${BAR} ${text}${RESET}`;
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

function resultText(result: any): string {
	const content = result?.content ?? result?.partialResult?.content;
	if (Array.isArray(content)) {
		return content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
	}
	return typeof result?.output === "string" ? result.output : "";
}

function wrappedOutput(text: string, width: number): string[] {
	const bodyWidth = Math.max(1, width - INDENT.length);
	const rows = text.replace(/\t/g, "   ").replace(/\s+$/, "").split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
	return rows.map((row) => barLine(row));
}

function boundedRows(rows: string[]): string[] {
	if (rows.length <= OUTPUT_ROWS) return rows;
	const head = 2;
	const tail = 2;
	const omitted = rows.length - head - tail;
	return [
		...rows.slice(0, head),
		barLine(`… +${omitted} lines (Ctrl+O for full output)`),
		...rows.slice(-tail),
	];
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
		const block = buildToolBlock("bash", this.args, this.result, {
			isPartial: this.options.partial,
			isError: this.options.error,
			elapsedMs: this.options.elapsedMs,
			theme: this.theme,
			cwd: this.options.cwd,
		});
		if (this.options.partial) {
			this.cachedLines = block.map((line) => fitToolLine(line, max));
			this.cachedWidth = max;
			return this.cachedLines;
		}

		const text = resultText(this.result);
		let output = text.trim() ? wrappedOutput(text, max) : [barLine("(no output)")];
		if (!this.options.expanded) output = boundedRows(output);
		// Branch rows (└ <command> · <summary>) wrap to ≤3 lines so long commands
		// stay readable; every other block line truncates to fit.
		const fittedBlock = block.flatMap((line) => line.startsWith("  └ ") ? wrapBranchLine(line, max) : [fitToolLine(line, max)]);
		this.cachedLines = [...fittedBlock, ...output];
		this.cachedWidth = max;
		return this.cachedLines;
	}
}

export default function bash(pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd());
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: withReasoning(bashTool.parameters),
		promptGuidelines: [
			'Always pass a "reasoning" phrase to bash: state the GOAL/intent, not the command.',
		],
		renderShell: "self",
		execute: async (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => {
			const { rest } = stripReasoning(params);
			return createBashTool(ctx.cwd).execute(id, rest, signal, onUpdate);
		},
		renderCall: (args: any, theme: any, context: any) => {
			if (!context?.isPartial) return new Container();
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
			if (options?.isPartial) return new Container();
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
