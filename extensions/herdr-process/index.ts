import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
	fitToolLine,
	normalizeToolReasoning,
	REASONING_DESCRIPTION,
	renderCommandOutput,
} from "../better-native-pi/core.js";

const TOOL_NAME = "herdr_process";
const DEFAULT_READ_LINES = 120;
const HERDR_TIMEOUT_MS = 5_000;
// Share of the Pi pane kept on the first split, so Pi keeps two-thirds of the tab.
const PRIMARY_KEEP_RATIO = "0.67";

type HerdrAction = "start" | "list" | "read" | "status" | "input" | "interrupt" | "close";

interface HerdrProcessArgs {
	reasoning: string;
	action: HerdrAction;
	command?: string;
	label?: string;
	direction?: "right" | "down";
	pane_id?: string;
	lines?: number;
	text?: string;
	press_enter?: boolean;
}

// Keep the schema as plain JSON Schema. Several repository tests intentionally
// replace TypeBox with narrow mocks; this extension does not need runtime builders.
const parameters = {
	type: "object",
	properties: {
		reasoning: { type: "string", description: REASONING_DESCRIPTION },
		action: { type: "string", enum: ["start", "list", "read", "status", "input", "interrupt", "close"], description: "Operation to perform." },
		command: { type: "string", minLength: 1, description: "Foreground shell command for action=start." },
		label: { type: "string", minLength: 1, maxLength: 80, description: "Short pane label for action=start." },
		direction: { type: "string", enum: ["right", "down"], description: "Split direction for action=start. Defaults to the split pane's longer side." },
		pane_id: { type: "string", minLength: 1, description: "Pane ID returned by action=start." },
		lines: { type: "integer", minimum: 1, maximum: DEFAULT_MAX_LINES, description: `Recent lines for action=read. Defaults to ${DEFAULT_READ_LINES}.` },
		text: { type: "string", description: "Text for action=input. It is not echoed in the tool result." },
		press_enter: { type: "boolean", description: "Press Enter after action=input. Defaults to true." },
	},
	required: ["reasoning", "action"],
	additionalProperties: false,
} as any;

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed?: boolean;
}

interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
}

interface RuntimeDependencies {
	env?: NodeJS.ProcessEnv;
	exec?: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
}

interface ProcessRecord {
	paneId: string;
	label: string;
	command: string;
	cwd: string;
	direction: "right" | "down";
}

interface HerdrProcessDetails {
	herdrProcess: true;
	action: HerdrAction;
	paneId?: string;
	label?: string;
	command?: string;
	cwd?: string;
	direction?: "right" | "down";
	processInfo?: unknown;
	knownPanes?: ProcessRecord[];
	truncated?: boolean;
}

interface ToolRenderContext {
	args?: unknown;
	isError?: boolean;
	isPartial?: boolean;
}

interface Theme {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

class ProcessLines implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly source: (width: number) => string[]) {}

	render(width: number): string[] {
		const max = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === max) return this.cachedLines;
		this.cachedLines = this.source(max).map((line) =>
			line.includes("\x1b") ? fitToolLine(line, max) : truncateToWidth(line, max, "…"),
		);
		this.cachedWidth = max;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function resultText(result: any): string {
	return result?.content
		?.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n") ?? "";
}

function actionVerb(action: HerdrAction | undefined, settled: boolean): string {
	const verbs: Record<HerdrAction, [running: string, complete: string]> = {
		start: ["Starting", "Started"],
		list: ["Listing", "Listed"],
		read: ["Reading", "Read"],
		status: ["Inspecting", "Inspected"],
		input: ["Sending input", "Sent input"],
		interrupt: ["Interrupting", "Interrupted"],
		close: ["Closing", "Closed"],
	};
	const pair = action ? verbs[action] : undefined;
	return pair?.[settled ? 1 : 0] ?? (settled ? "Used Herdr process" : "Using Herdr process");
}

function targetLabel(args: Partial<HerdrProcessArgs>, details?: HerdrProcessDetails): string | undefined {
	const action = args.action ?? details?.action;
	if (action === "start") return details?.label ?? args.label;
	if (!action || action === "list") return undefined;
	return details?.paneId ?? args.pane_id;
}

function renderHeadline(
	action: HerdrAction | undefined,
	reasoning: string | undefined,
	settled: boolean,
	isError: boolean,
	theme: Theme,
): string {
	const color = !settled ? "accent" : isError ? "error" : "success";
	const mark = theme.fg(color, "•");
	const verb = isError ? (action ? `${actionVerb(action, false)} failed` : "Herdr process failed") : actionVerb(action, settled);
	const intent = normalizeToolReasoning(reasoning);
	return `${mark} ${theme.bold(verb)}${intent ? ` ${theme.fg("accent", intent)}` : ""}`;
}

function renderCall(rawArgs: Partial<HerdrProcessArgs> | undefined, theme: Theme, context: ToolRenderContext): Component {
	if (!context.isPartial) return new Container();
	const args = rawArgs ?? {};
	return new ProcessLines(() => {
		const lines = [renderHeadline(args.action, args.reasoning, false, false, theme)];
		const target = targetLabel(args);
		if (target) lines.push(`  └ ${theme.fg("dim", target)}`);
		return lines;
	});
}

function renderResult(
	result: any,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: ToolRenderContext,
): Component {
	if (options.isPartial) return new Container();
	const args = context.args && typeof context.args === "object"
		? context.args as Partial<HerdrProcessArgs>
		: {};
	const details = result?.details as HerdrProcessDetails | undefined;
	const action = args.action ?? details?.action;
	const text = resultText(result);

	return new ProcessLines((width) => {
		const lines = [renderHeadline(action, args.reasoning, true, Boolean(context.isError), theme)];
		const target = targetLabel(args, details);
		if (target) {
			const pane = details?.paneId && details.paneId !== target ? ` · ${details.paneId}` : "";
			lines.push(`  └ ${theme.fg("dim", `${target}${pane}`)}`);
		}
		if (context.isError || action === "read" || action === "status" || action === "list") {
			lines.push(...renderCommandOutput(text, width, { maxRows: options.expanded ? undefined : 8 }));
		}
		return lines;
	});
}

function compactLabel(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= 80 ? compact : `${compact.slice(0, 79)}…`;
}

function commandLabel(command: string): string {
	return compactLabel(command) || "process";
}

function parseJson(text: string, operation: string): any {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Herdr ${operation} returned invalid JSON.`);
	}
}

function failureMessage(result: ExecResult): string {
	return (result.stderr || result.stdout || `exit code ${result.code ?? "unknown"}`).trim().slice(0, 2_000);
}

function processInfoText(payload: any, paneId: string): string {
	const info = payload?.result?.process_info;
	const processes = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
	if (processes.length === 0) return `No foreground process is reported for ${paneId}.`;
	return processes.map((process: any) => {
		const name = typeof process?.name === "string" && process.name ? process.name : "process";
		const pid = Number.isInteger(process?.pid) ? ` (PID ${process.pid})` : "";
		const command = typeof process?.cmdline === "string" && process.cmdline ? `: ${process.cmdline}` : "";
		return `${name}${pid}${command}`;
	}).join("\n");
}

/**
 * Describes what still runs in a pane, or returns undefined when only its shell
 * remains. Herdr reports the shell's own process group as the foreground group
 * once a command exits or is interrupted. Missing or malformed fields count as
 * busy so that close never guesses in favor of killing a process. A command
 * the shell has not started yet (right after action=start) also looks idle.
 */
function busyDescription(payload: any, paneId: string): string | undefined {
	const info = payload?.result?.process_info;
	const shellPid = info?.shell_pid;
	const foregroundGroup = info?.foreground_process_group_id;
	if (Number.isInteger(shellPid) && foregroundGroup === shellPid) return undefined;
	return processInfoText(payload, paneId);
}

interface PaneRect {
	width: number;
	height: number;
}

interface SplitPlan {
	/** Owned pane to split, or undefined for Pi's own pane. */
	target?: string;
	direction: "right" | "down";
	ratio?: string;
}

function area(rect: PaneRect): number {
	return rect.width * rect.height;
}

/**
 * Splits along the pane's visually longer side. Terminal cells are about twice
 * as tall as they are wide, so a pane at least twice as many columns as rows
 * stays readable side by side; anything narrower splits top and bottom.
 */
function longerSide(rect: PaneRect | undefined): "right" | "down" | undefined {
	if (!rect) return undefined;
	return rect.width / rect.height >= 2 ? "right" : "down";
}

function isPaneNotFound(result: ExecResult): boolean {
	return `${result.stdout}\n${result.stderr}`.includes("pane_not_found");
}

function restoredRecord(details: any): ProcessRecord | undefined {
	if (details?.herdrProcess !== true || details?.action !== "start") return undefined;
	if (typeof details.paneId !== "string" || typeof details.label !== "string" || typeof details.command !== "string") return undefined;
	if (typeof details.cwd !== "string" || (details.direction !== "right" && details.direction !== "down")) return undefined;
	return {
		paneId: details.paneId,
		label: details.label,
		command: details.command,
		cwd: details.cwd,
		direction: details.direction,
	};
}

export default function herdrProcessExtension(pi: ExtensionAPI, dependencies: RuntimeDependencies = {}) {
	const env = dependencies.env ?? process.env;
	if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return;

	const exec = dependencies.exec ?? ((command, args, options) => pi.exec(command, args, options));
	const knownPanes = new Map<string, ProcessRecord>();
	let toolRegistered = false;

	const runHerdr = async (args: string[], signal?: AbortSignal): Promise<ExecResult> => {
		const result = await exec("herdr", args, { signal, timeout: HERDR_TIMEOUT_MS });
		if (result.code !== 0) throw new Error(`Herdr ${args.slice(0, 2).join(" ")} failed: ${failureMessage(result)}`);
		return result;
	};

	/** Pane sizes in the current tab, keyed by pane ID; undefined when Herdr cannot report them. */
	const readLayout = async (signal?: AbortSignal): Promise<Map<string, PaneRect> | undefined> => {
		try {
			const result = await runHerdr(["pane", "layout", "--current"], signal);
			const panes = parseJson(result.stdout, "pane layout")?.result?.layout?.panes;
			if (!Array.isArray(panes)) return undefined;
			const rects = new Map<string, PaneRect>();
			for (const pane of panes) {
				const { width, height } = pane?.rect ?? {};
				if (typeof pane?.pane_id === "string" && typeof width === "number" && typeof height === "number" && height > 0) {
					rects.set(pane.pane_id, { width, height });
				}
			}
			return rects;
		} catch {
			return undefined;
		}
	};

	/**
	 * Picks where a new process pane goes. The first one takes a third of Pi's
	 * pane. Later ones split the largest process pane this session owns, so Pi
	 * keeps its two-thirds and user-created panes are never touched.
	 */
	const planSplit = async (requested: HerdrProcessArgs["direction"], signal?: AbortSignal): Promise<SplitPlan> => {
		const layout = await readLayout(signal);
		const owned = [...knownPanes.keys()];
		// Without a layout, assume the newest owned pane still exists; start
		// falls back to splitting Pi's pane if Herdr reports it gone.
		const auxiliary = layout
			? owned
				.filter((paneId) => layout.has(paneId))
				.sort((a, b) => area(layout.get(b)!) - area(layout.get(a)!))[0]
			: owned.at(-1);
		if (auxiliary) {
			return { target: auxiliary, direction: requested ?? longerSide(layout?.get(auxiliary)) ?? "down" };
		}
		const primary = env.HERDR_PANE_ID ? layout?.get(env.HERDR_PANE_ID) : undefined;
		return { target: undefined, direction: requested ?? longerSide(primary) ?? "right", ratio: PRIMARY_KEEP_RATIO };
	};

	const splitPane = (plan: SplitPlan, cwd: string, signal?: AbortSignal) => exec("herdr", [
		"pane", "split", ...(plan.target ? ["--pane", plan.target] : ["--current"]),
		"--direction", plan.direction, ...(plan.ratio ? ["--ratio", plan.ratio] : []),
		"--cwd", cwd, "--no-focus",
	], { signal, timeout: HERDR_TIMEOUT_MS });

	const requireKnownPane = (paneId: unknown): ProcessRecord => {
		if (typeof paneId !== "string" || !paneId.trim()) throw new Error("pane_id is required for this action.");
		const record = knownPanes.get(paneId);
		if (!record) throw new Error(`Refusing to control unknown pane ${paneId}; use a pane ID returned by this session's herdr_process action=start.`);
		return record;
	};

	const restoreKnownPanes = (ctx: any) => {
		knownPanes.clear();
		const entries = typeof ctx.sessionManager?.getBranch === "function"
			? ctx.sessionManager.getBranch()
			: ctx.sessionManager?.getEntries?.() ?? [];
		for (const entry of entries) {
			const message = entry?.type === "message" ? entry.message : undefined;
			if (message?.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
			// A persisted close releases ownership, so a reload cannot target a pane
			// ID that Herdr may later reuse for an unrelated pane.
			if (message.details?.herdrProcess === true && message.details.action === "close") {
				knownPanes.delete(message.details.paneId);
				continue;
			}
			const record = restoredRecord(message.details);
			if (record) knownPanes.set(record.paneId, record);
		}
	};

	const execute = async (_toolCallId: string, params: HerdrProcessArgs, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => {
		switch (params.action) {
			case "start": {
				const command = params.command?.trim();
				if (!command) throw new Error("command is required for action=start.");
				const label = compactLabel(params.label ?? commandLabel(command));
				let plan = await planSplit(params.direction, signal);
				let split = await splitPane(plan, ctx.cwd, signal);
				if (plan.target && isPaneNotFound(split)) {
					// The owned pane vanished outside this tool; forget it and start over
					// from the next owned pane or Pi's pane.
					knownPanes.delete(plan.target);
					plan = await planSplit(params.direction, signal);
					split = await splitPane(plan, ctx.cwd, signal);
				}
				if (split.code !== 0) throw new Error(`Herdr pane split failed: ${failureMessage(split)}`);
				const direction = plan.direction;
				const paneId = parseJson(split.stdout, "pane split")?.result?.pane?.pane_id;
				if (typeof paneId !== "string" || !paneId) throw new Error("Herdr pane split did not return a pane ID.");

				let renameWarning: string | undefined;
				try {
					await runHerdr(["pane", "rename", paneId, label], signal);
				} catch (error) {
					renameWarning = error instanceof Error ? error.message : String(error);
				}
				await runHerdr(["pane", "run", paneId, command], signal);

				const record: ProcessRecord = { paneId, label, command, cwd: ctx.cwd, direction };
				knownPanes.set(paneId, record);
				const warning = renameWarning ? ` Pane rename warning: ${renameWarning}` : "";
				return {
					content: [{ type: "text", text: `Started ${label} in visible Herdr pane ${paneId}.${warning}` }],
					details: { herdrProcess: true, action: "start", ...record } satisfies HerdrProcessDetails,
				};
			}

			case "list": {
				const records = [...knownPanes.values()];
				const text = records.length === 0
					? "No Herdr process panes were started by this session."
					: records.map((record) => `${record.paneId} — ${record.label}`).join("\n");
				return {
					content: [{ type: "text", text }],
					details: { herdrProcess: true, action: "list", knownPanes: records } satisfies HerdrProcessDetails,
				};
			}

			case "read": {
				const record = requireKnownPane(params.pane_id);
				const lines = params.lines ?? DEFAULT_READ_LINES;
				const recent = await runHerdr([
					"pane", "read", record.paneId, "--source", "recent-unwrapped",
					"--lines", String(lines), "--format", "text",
				], signal);
				// Herdr 0.8.2 can return an empty recent snapshot while all live output
				// still fits in the viewport. Fall back to that visible snapshot.
				const output = recent.stdout.trim()
					? recent.stdout
					: (await runHerdr([
						"pane", "read", record.paneId, "--source", "visible",
						"--lines", String(lines), "--format", "text",
					], signal)).stdout;
				const truncated = truncateTail(output, { maxLines: lines, maxBytes: DEFAULT_MAX_BYTES });
				const notice = truncated.truncated
					? `\n\n[Showing the last ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). View the Herdr pane for complete output.]`
					: "";
				return {
					content: [{ type: "text", text: `${truncated.content}${notice}` || "(no pane output)" }],
					details: { herdrProcess: true, action: "read", paneId: record.paneId, label: record.label, truncated: truncated.truncated } satisfies HerdrProcessDetails,
				};
			}

			case "status": {
				const record = requireKnownPane(params.pane_id);
				const result = await runHerdr(["pane", "process-info", "--pane", record.paneId], signal);
				const payload = parseJson(result.stdout, "pane process-info");
				return {
					content: [{ type: "text", text: processInfoText(payload, record.paneId) }],
					details: { herdrProcess: true, action: "status", paneId: record.paneId, label: record.label, processInfo: payload?.result?.process_info } satisfies HerdrProcessDetails,
				};
			}

			case "input": {
				const record = requireKnownPane(params.pane_id);
				if (params.text === undefined) throw new Error("text is required for action=input.");
				if (!params.text && params.press_enter === false) throw new Error("action=input needs text or press_enter=true.");
				if (params.text) await runHerdr(["pane", "send-text", record.paneId, params.text], signal);
				if (params.press_enter !== false) await runHerdr(["pane", "send-keys", record.paneId, "enter"], signal);
				return {
					content: [{ type: "text", text: `Sent input to Herdr pane ${record.paneId}.` }],
					details: { herdrProcess: true, action: "input", paneId: record.paneId, label: record.label } satisfies HerdrProcessDetails,
				};
			}

			case "interrupt": {
				const record = requireKnownPane(params.pane_id);
				await runHerdr(["pane", "send-keys", record.paneId, "ctrl+c"], signal);
				return {
					content: [{ type: "text", text: `Sent Ctrl+C to Herdr pane ${record.paneId}.` }],
					details: { herdrProcess: true, action: "interrupt", paneId: record.paneId, label: record.label } satisfies HerdrProcessDetails,
				};
			}

			case "close": {
				const record = requireKnownPane(params.pane_id);
				const done = (text: string) => {
					knownPanes.delete(record.paneId);
					return {
						content: [{ type: "text", text }],
						details: { herdrProcess: true, action: "close", paneId: record.paneId, label: record.label } satisfies HerdrProcessDetails,
					};
				};

				// Call exec directly so a pane that already disappeared (for example,
				// the user closed it) releases ownership instead of failing.
				const info = await exec("herdr", ["pane", "process-info", "--pane", record.paneId], { signal, timeout: HERDR_TIMEOUT_MS });
				if (isPaneNotFound(info)) return done(`Herdr pane ${record.paneId} is already gone.`);
				if (info.code !== 0) throw new Error(`Herdr pane process-info failed: ${failureMessage(info)}`);
				const busy = busyDescription(parseJson(info.stdout, "pane process-info"), record.paneId);
				if (busy) {
					throw new Error(`Refusing to close Herdr pane ${record.paneId} while a process is running; use action=interrupt first.\n${busy}`);
				}

				const closed = await exec("herdr", ["pane", "close", record.paneId], { signal, timeout: HERDR_TIMEOUT_MS });
				if (closed.code !== 0 && !isPaneNotFound(closed)) {
					throw new Error(`Herdr pane close failed: ${failureMessage(closed)}`);
				}
				return done(`Closed Herdr pane ${record.paneId}.`);
			}
		}
	};

	const registerTool = () => {
		if (toolRegistered) return;
		toolRegistered = true;
		pi.registerTool({
			name: TOOL_NAME,
			label: "Herdr Process",
			description: "Start and control long-running foreground commands in visible sibling Herdr panes. Processes remain attached to Herdr instead of blocking Pi. Control actions accept only pane IDs created by this Pi session. Read output is capped at 2,000 lines or 50KB.",
			promptGuidelines: [
				"Keep Herdr processes in the foreground. Use herdr_process action=interrupt to stop one. After its work and any needed output are done, close its idle pane with action=close; start a fresh pane for later work.",
			],
			parameters,
			executionMode: "sequential",
			execute,
			renderShell: "self",
			renderCall,
			renderResult,
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		restoreKnownPanes(ctx);
		registerTool();
	});
}
