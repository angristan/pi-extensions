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

const UPDATE_INTERVAL_MS = 120;
const INDICATOR_FRAMES: string[] = [];
const PULSE_PERIOD_FRAMES = 24;
const FALLBACK_BASE_RGB: Rgb = { r: 168, g: 153, b: 132 };
const FALLBACK_ACCENT_RGB: Rgb = { r: 211, g: 134, b: 155 };

export type WorkingPhase = "waiting" | "thinking" | "tools" | "retrying" | "compacting";

type ThemeColor = "accent" | "dim" | "muted" | "text";
type Rgb = { r: number; g: number; b: number };
type WorkingMessageTheme = {
	fg(color: ThemeColor, text: string): string;
	getFgAnsi?(color: ThemeColor): string;
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

function ansiForThemeColor(theme: WorkingMessageTheme, color: ThemeColor): string {
	if (theme.getFgAnsi) return theme.getFgAnsi(color);
	const sample = theme.fg(color, "x");
	return sample.replace("x", "");
}

function parseAnsiRgb(ansi: string): Rgb | undefined {
	const trueColor = ansi.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	if (trueColor) {
		return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
	}

	const indexed = ansi.match(/\x1b\[38;5;(\d+)m/);
	if (indexed) return ansi256ToRgb(Number(indexed[1]));
	return undefined;
}

function ansi256ToRgb(index: number): Rgb | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	const basic: Rgb[] = [
		{ r: 0, g: 0, b: 0 },
		{ r: 128, g: 0, b: 0 },
		{ r: 0, g: 128, b: 0 },
		{ r: 128, g: 128, b: 0 },
		{ r: 0, g: 0, b: 128 },
		{ r: 128, g: 0, b: 128 },
		{ r: 0, g: 128, b: 128 },
		{ r: 192, g: 192, b: 192 },
		{ r: 128, g: 128, b: 128 },
		{ r: 255, g: 0, b: 0 },
		{ r: 0, g: 255, b: 0 },
		{ r: 255, g: 255, b: 0 },
		{ r: 0, g: 0, b: 255 },
		{ r: 255, g: 0, b: 255 },
		{ r: 0, g: 255, b: 255 },
		{ r: 255, g: 255, b: 255 },
	];
	if (index < basic.length) return basic[index];
	if (index >= 232) {
		const value = 8 + (index - 232) * 10;
		return { r: value, g: value, b: value };
	}
	const offset = index - 16;
	const r = Math.floor(offset / 36);
	const g = Math.floor((offset % 36) / 6);
	const b = offset % 6;
	const convert = (value: number) => (value === 0 ? 0 : 55 + value * 40);
	return { r: convert(r), g: convert(g), b: convert(b) };
}

function lerp(start: number, end: number, amount: number): number {
	return Math.round(start + (end - start) * amount);
}

function rgbAnsi({ r, g, b }: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

function pulseColor(theme: WorkingMessageTheme, frame: number): Rgb {
	const base =
		parseAnsiRgb(ansiForThemeColor(theme, "text")) ??
		parseAnsiRgb(ansiForThemeColor(theme, "muted")) ??
		FALLBACK_BASE_RGB;
	const accent = parseAnsiRgb(ansiForThemeColor(theme, "accent")) ?? FALLBACK_ACCENT_RGB;
	const phase = (frame % PULSE_PERIOD_FRAMES) / PULSE_PERIOD_FRAMES;
	const intensity = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);

	return {
		r: lerp(base.r, accent.r, intensity),
		g: lerp(base.g, accent.g, intensity),
		b: lerp(base.b, accent.b, intensity),
	};
}

export function pulseText(text: string, frame: number, theme: WorkingMessageTheme): string {
	if (text.length === 0) return "";

	// Pi's built-in working row wraps the full message in muted. Emit an explicit
	// RGB foreground every frame so the phase label can move smoothly between the
	// base foreground and the theme accent instead of jumping between theme tokens.
	return `${rgbAnsi(pulseColor(theme, frame))}${text}`;
}

export function formatWorkingMessage(
	phase: WorkingPhase,
	elapsedMs: number,
	interruptKey: string | undefined,
	frameOrTheme?: number | WorkingMessageTheme,
	maybeTheme?: WorkingMessageTheme,
): string {
	const interruptHint = interruptKey ? ` • ${interruptKey} to interrupt` : "";
	const frame = typeof frameOrTheme === "number" ? frameOrTheme : 0;
	const theme = typeof frameOrTheme === "number" ? maybeTheme : frameOrTheme;
	const label = PHASE_LABELS[phase];
	const header = theme ? pulseText(label, frame, theme) : label;
	const suffix = `(${formatElapsed(elapsedMs)}${interruptHint})`;
	return `${header} ${theme ? theme.fg("dim", suffix) : suffix}`;
}

export default function workingTimer(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let phase: WorkingPhase = "waiting";
	let textFrame = 0;
	let activeToolExecutions = 0;
	let renderCtx: ExtensionContext | undefined;
	let interruptKey: string | undefined;

	const installIndicator = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({ frames: INDICATOR_FRAMES });
	};

	const render = (ctx = renderCtx) => {
		if (ctx?.mode !== "tui" || startedAt === undefined) return;
		renderCtx = ctx;
		ctx.ui.setWorkingMessage(formatWorkingMessage(phase, Date.now() - startedAt, interruptKey, textFrame, ctx.ui.theme));
		textFrame += 1;
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
		textFrame = 0;
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
		textFrame = 0;

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
