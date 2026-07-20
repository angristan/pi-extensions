/**
 * working-timer — adds elapsed time and phase text to Pi's built-in working row.
 *
 * The first agent_start anchors a user-visible run. The timer remains anchored
 * across retries, automatic compaction, and queued continuations, then resets
 * only after agent_settled. Pi's retry and compaction loaders keep their native
 * messages; the elapsed time resumes when the normal working row returns.
 */
import {
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const UPDATE_INTERVAL_MS = 1_000;
const INDICATOR_INTERVAL_MS = 300;
const RAIL_POSITIONS = [0, 1, 2, 1] as const;
const NORMAL_FG = "\x1b[39m";

export type WorkingPhase = "waiting" | "thinking" | "tools" | "retrying" | "compacting";

type ThemeColor = "accent" | "dim";
type WorkingMessageTheme = {
	fg(color: ThemeColor, text: string): string;
};

const PHASE_LABELS: Record<WorkingPhase, string> = {
	waiting: "Waiting for model",
	thinking: "Thinking",
	tools: "Running tools",
	retrying: "Retrying",
	compacting: "Compacting",
};

function isRetryStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

function formatRailFrame(activeIndex: number, theme: WorkingMessageTheme): string {
	const cells = [0, 1, 2]
		.map((index) => theme.fg(index === activeIndex ? "accent" : "dim", index === activeIndex ? "•" : "·"))
		.join("");
	return `${theme.fg("dim", "[")}${cells}${theme.fg("dim", "]")}`;
}

function formatRailFrames(theme: WorkingMessageTheme): string[] {
	return RAIL_POSITIONS.map((position) => formatRailFrame(position, theme));
}

export function formatWorkingMessage(
	phase: WorkingPhase,
	elapsedMs: number,
	interruptKey: string | undefined,
	frameOrTheme?: number | WorkingMessageTheme,
	maybeTheme?: WorkingMessageTheme,
): string {
	const interruptHint = interruptKey ? ` • ${interruptKey} to interrupt` : "";
	const theme = typeof frameOrTheme === "number" ? maybeTheme : frameOrTheme;
	const label = PHASE_LABELS[phase];
	const header = theme ? `${NORMAL_FG}${label}` : label;
	const suffix = `(${formatElapsed(elapsedMs)}${interruptHint})`;
	return `${header} ${theme ? theme.fg("dim", suffix) : suffix}`;
}

export default function workingTimer(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let phase: WorkingPhase = "waiting";
	let activeToolExecutions = 0;
	let renderCtx: ExtensionContext | undefined;
	let interruptKey: string | undefined;

	const installIndicator = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({ frames: formatRailFrames(ctx.ui.theme), intervalMs: INDICATOR_INTERVAL_MS });
	};

	const render = (ctx = renderCtx) => {
		if (ctx?.mode !== "tui" || startedAt === undefined) return;
		renderCtx = ctx;
		ctx.ui.setWorkingMessage(formatWorkingMessage(phase, Date.now() - startedAt, interruptKey, ctx.ui.theme));
	};

	const setPhase = (nextPhase: WorkingPhase, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || startedAt === undefined || phase === nextPhase) return;
		phase = nextPhase;
		render(ctx);
	};

	const stop = (ctx?: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		startedAt = undefined;
		renderCtx = undefined;
		activeToolExecutions = 0;
		if (ctx?.mode === "tui") ctx.ui.setWorkingMessage();
	};

	pi.on("session_start", (_event, ctx) => installIndicator(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		activeToolExecutions = 0;
		interruptKey = keyText("app.interrupt") || undefined;

		// Preserve the first start across retries, compaction, and automatic
		// continuations so this measures the complete user-visible run.
		if (startedAt === undefined) startedAt = Date.now();
		phase = "waiting";
		render(ctx);
		if (timer) return;

		timer = setInterval(() => render(), UPDATE_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("before_provider_request", (_event, ctx) => setPhase("waiting", ctx));
	pi.on("after_provider_response", (event, ctx) => setPhase(isRetryStatus(event.status) ? "retrying" : "thinking", ctx));
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "assistant") setPhase("thinking", ctx);
	});
	pi.on("message_update", (event, ctx) => {
		if (event.message.role === "assistant") setPhase("thinking", ctx);
	});
	pi.on("tool_execution_start", (_event, ctx) => {
		activeToolExecutions += 1;
		setPhase("tools", ctx);
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		activeToolExecutions = Math.max(0, activeToolExecutions - 1);
		if (activeToolExecutions === 0) setPhase("thinking", ctx);
	});
	pi.on("session_before_compact", (_event, ctx) => setPhase("compacting", ctx));
	pi.on("session_compact", (event, ctx) => setPhase(event.willRetry ? "retrying" : "thinking", ctx));

	pi.on("agent_settled", (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		stop(ctx);
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator();
	});
}
