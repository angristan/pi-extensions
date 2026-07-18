/**
 * file-tools — restyles pi's 6 built-in file tools (read/write/edit/grep/find/ls)
 * into compact 2-line transcript blocks. Re-registers each under its native name
 * with `renderShell: "self"`, injects a required `reasoning` param, and delegates
 * `execute` to the real built-in tool.
 *
 * Line 1: {bullet} {semantic verb} {reasoning headline}
 * Line 2: {branch} {arg/command detail} · {colored summary}
 *
 * Why `renderShell: "self"`: pi bakes a Spacer(1) inside every tool's
 * ToolExecutionComponent, so N default cards = N blank lines. In self mode
 * ToolExecutionComponent.render() skips that spacer — one separator + 2 tight
 * lines per tool.
 *
 * Successful edit/write calls append their syntax-highlighted, line-numbered
 * structured diff inline; C-o (app.tools.expand) reveals raw output or full
 * written content without duplicating an edit diff already shown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createLsToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	generateDiffString,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	ContentAddressedImageStore,
	renderStoredImagePreviews,
	type StoredImagePreviewState,
} from "../image-store/index.js";
import {
	EXPLORATION_DETAILS_KEY,
	enableExplorationToolRendering,
	isExplorationTool,
	renderExplorationCall,
	renderExplorationResult,
} from "./exploration.js";
import {
	Container,
	WidthAwareLines,
	buildToolBlock,
	diffPalette,
	withReasoning,
} from "./core.js";

function withStoredImagePreviews(
	base: Component,
	toolName: string,
	result: any,
	options: any,
	theme: any,
	store: ContentAddressedImageStore,
	invalidate?: () => void,
	state?: StoredImagePreviewState,
): Component {
	if (toolName !== "read") return base;
	const previews = renderStoredImagePreviews(
		result?.details,
		store,
		theme,
		options?.expanded ?? false,
		invalidate,
		state,
	);
	if (!previews) return base;
	return {
		render: (width: number) => [...base.render(width), ...previews.render(width)],
		invalidate: () => {
			base.invalidate?.();
			previews.invalidate?.();
		},
	};
}

export default function fileTools(pi: ExtensionAPI) {
	const imageStore = new ContentAddressedImageStore();

	// Exploration grouping and the compact tool renderers are deliberately
	// coupled: the group renderer owns read/list/search rows.
	enableExplorationToolRendering();

	// Track each tool call's start time so running blocks can show elapsed time,
	// and clear the map at turn end so aborted/interrupted calls don't leak.
	const startedAtByCallId = new Map<string, number>();

	pi.on("tool_execution_start", async (e: any) => {
		if (!startedAtByCallId.has(e.toolCallId)) startedAtByCallId.set(e.toolCallId, Date.now());
	});

	pi.on("turn_end", async () => {
		// toolCallIds never span turns; drop any entries whose end never fired
		// (e.g. an interrupted/aborted call) so the map can't grow unbounded.
		startedAtByCallId.clear();
	});

	const toolFactories: Record<string, (cwd: string) => any> = {
		read: createReadTool,
		write: createWriteTool,
		edit: createEditTool,
		grep: createGrepTool,
		find: createFindTool,
		ls: createLsTool,
	};
	const builtinTools: Record<string, any> = {
		read: createReadToolDefinition(process.cwd()),
		write: createWriteToolDefinition(process.cwd()),
		edit: createEditToolDefinition(process.cwd()),
		grep: createGrepToolDefinition(process.cwd()),
		find: createFindToolDefinition(process.cwd()),
		ls: createLsToolDefinition(process.cwd()),
	};

	for (const [name, tool] of Object.entries(builtinTools)) {
		pi.registerTool({
			name,
			label: name,
			description: tool.description,
			promptSnippet: tool.promptSnippet,
			parameters: withReasoning(tool.parameters),
			prepareArguments: tool.prepareArguments,
			promptGuidelines: tool.promptGuidelines,
			renderShell: "self",

			// Strip our injected `reasoning`, delegate to the real built-in. Writes
			// use per-call operations so the before-content is read inside Pi's file
			// mutation queue and can produce the same diff format as edit.
			execute: async (id: string, p: any, sig: any, up: any, ctx: any) => {
				const { rest } = stripReasoning(p);
				if (name !== "write") {
					const runtimeTool = toolFactories[name]!(ctx.cwd);
					return runtimeTool.execute(id, rest, sig, up);
				}

				let diff = "";
				const writeTool = createWriteTool(ctx.cwd, {
					operations: {
						mkdir: async (directory: string) => { await mkdir(directory, { recursive: true }); },
						writeFile: async (path: string, content: string) => {
							let previous = "";
							try {
								previous = await readFile(path, "utf8");
							} catch (error: any) {
								if (error?.code !== "ENOENT") throw error;
							}
							await mkdir(dirname(path), { recursive: true });
							await writeFile(path, content, "utf8");
							diff = generateDiffString(previous, content).diff;
						},
					},
				});
				const result = await writeTool.execute(id, rest, sig, up);
				return { ...result, details: { ...(result.details ?? {}), diff } };
			},

			// The call slot owns the running block. Do not schedule periodic invalidation:
			// autonomous transcript redraws can pull a scrolled viewport back down.
			renderCall: (args: any, theme: any, context: any) => {
				if (context?.isPartial && isExplorationTool(name)) {
					const exploration = renderExplorationCall(name, args, theme, context);
					if (exploration !== undefined) return exploration;
				}
				if (!context?.isPartial) return new Container();
				const toolCallId = context.toolCallId as string;
				let startedAt = startedAtByCallId.get(toolCallId);
				if (startedAt === undefined) {
					startedAt = Date.now();
					startedAtByCallId.set(toolCallId, startedAt);
				}
				return new WidthAwareLines(() => buildToolBlock(name, args ?? {}, {}, {
					isPartial: true,
					elapsedMs: Date.now() - startedAt,
					theme,
					cwd: context.cwd,
				}), undefined, true);
			},

			// The result slot stays empty for streaming partials to avoid duplicating
			// the running call block, then replaces it with the settled output.
			renderResult: (result: any, options: any, theme: any, context: any) => {
				if (!options?.isPartial && result?.details?.[EXPLORATION_DETAILS_KEY]) {
					const exploration = renderExplorationResult(name, result, options, theme, context);
					if (exploration !== undefined) {
						return withStoredImagePreviews(
							exploration,
							name,
							result,
							options,
							theme,
							imageStore,
							context?.invalidate,
							context?.state,
						);
					}
				}
				if (options?.isPartial) return new Container();
				const isError = context?.isError ?? result?.isError ?? false;
				const toolCallId = context?.toolCallId as string | undefined;
				const startedAt = startedAtByCallId.get(toolCallId ?? "");
				const args = context?.args ?? {};
				const elapsedMs = startedAt === undefined ? 0 : Date.now() - startedAt;
				const block = new WidthAwareLines(() => buildToolBlock(name, args, result, {
					isError,
					expanded: options?.expanded ?? false,
					elapsedMs,
					theme,
					cwd: context?.cwd,
				}), diffPalette(theme));
				return withStoredImagePreviews(
					block,
					name,
					result,
					options,
					theme,
					imageStore,
					context?.invalidate,
					context?.state,
				);
			},
		});
	}
}

/** Strip our injected `reasoning` before delegating to the real tool. */
function stripReasoning(params: any): { reasoning?: string; rest: any } {
	if (!params || typeof params !== "object") return { rest: params };
	const { reasoning, ...rest } = params;
	return { reasoning: typeof reasoning === "string" ? reasoning : undefined, rest };
}
