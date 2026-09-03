/**
 * thinking-tokens — live thinking-token progress without transcript redraws.
 *
 * Pi renders hidden thinking blocks as a static "Thinking..." label with no
 * progress signal. Driving that label live via `setHiddenThinkingLabel` is not
 * viable: every push re-renders every assistant message component, and any
 * change to a transcript line above the viewport forces a full-screen redraw
 * with scrollback replay. Per-token, that storms the renderer.
 *
 * So the live counter lives in a one-line widget above the editor instead:
 * `⠋ Thinking… 1.2k`. Widget updates only diff the bottom rows of the screen
 * and never touch transcript lines. Streaming updates only mark state dirty; a
 * single 100ms tick while an episode is live pushes at most one widget render
 * per interval, so token bursts cannot queue renders.
 *
 * When a message settles, the exact provider-reported reasoning count (or the
 * final estimate) is published as a cross-extension event, and the widget
 * disappears. The transcript keeps Pi's plain labels.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const THINKING_TOKENS_EVENT = "thinking-tokens:episode";

export interface ThinkingEpisodeEvent {
	/** Exact reasoning tokens when the provider reports them, else the estimate. */
	reasoningTokens: number;
	/** True when the figure is the provider's exact count, false when estimated. */
	exact: boolean;
}

const WIDGET_KEY = "thinking-tokens";
const CHARS_PER_TOKEN = 4;
/** One widget render per interval at most, so token bursts stay invisible. */
const TICK_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠖", "⠒", "⠐", "⠂", "⠂"] as const;

/** Compact token count, e.g. `512`, `1.2k`, `3.4M`. */
export function formatTokenCount(value: number): string {
	const safe = Math.max(0, Math.trunc(value));
	if (safe === 0) return "0";
	if (safe < 1_000) return String(safe);
	const [scaled, suffix] = safe >= 1_000_000
		? [safe / 1_000_000, "M"]
		: [safe / 1_000, "k"];
	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	let formatted = scaled.toFixed(decimals);
	while (formatted.includes(".") && formatted.endsWith("0")) formatted = formatted.slice(0, -1);
	if (formatted.endsWith(".")) formatted = formatted.slice(0, -1);
	return `${formatted}${suffix}`;
}

/** Estimate tokens from thinking text length. Providers do not report reasoning
 *  tokens mid-stream, so streamed text length is the only live signal. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Live estimate for a streaming assistant message: the sum over its thinking
 *  blocks, so interleaved thinking (multiple blocks per message) adds up. */
export function estimateThinkingTokens(message: AssistantMessage): number {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "thinking") total += estimateTokens(block.thinking);
	}
	return total;
}

/** Exact reasoning tokens from the message usage payload, when the provider reports them. */
export function exactReasoningTokens(message: AssistantMessage): number | undefined {
	const reasoning = message.usage?.reasoning;
	return typeof reasoning === "number" && reasoning >= 0 ? reasoning : undefined;
}

export function formatWidgetLine(count: number, spinnerFrame: number, fg: (color: "accent" | "dim", text: string) => string): string {
	const spinner = SPINNER_FRAMES[Math.abs(spinnerFrame) % SPINNER_FRAMES.length];
	return `${fg("accent", spinner)} ${fg("dim", `Thinking… ${formatTokenCount(count)}`)}`;
}

export interface ThinkingEpisode {
	/** Final reasoning tokens for the episode, exact when the provider reports them. */
	reasoningTokens: number;
	exact: boolean;
}

interface RuntimeDependencies {
	/** Interval factory for tests. */
	setInterval?: (callback: () => void, ms: number) => { unref?: () => void };
	clearInterval?: (timer: unknown) => void;
}

export default function thinkingTokens(pi: ExtensionAPI, deps: RuntimeDependencies = {}) {
	const setInterval_ = deps.setInterval ?? ((callback: () => void, ms: number) => globalThis.setInterval(callback, ms));
	const clearInterval_ = deps.clearInterval ?? ((timer: unknown) => globalThis.clearInterval(timer as any));

	// Episode state. `dirty` marks that the widget line changed since the last
	// pushed render; the tick is the only place that renders, so bursts of
	// message_update events collapse into at most one render per interval.
	let dirty = false;
	let episodeLive = false;
	let count = 0;
	let spinnerFrame = 0;
	let lastLine: string | undefined;
	let ctxRef: ExtensionContext | undefined;

	const isAssistant = (message: unknown): message is AssistantMessage =>
		(message as AssistantMessage).role === "assistant";

	const fg = (ctx: ExtensionContext) =>
		(color: "accent" | "dim", text: string) => ctx.ui.theme.fg(color, text);

	const push = () => {
		const ctx = ctxRef;
		if (ctx?.mode !== "tui") return;
		const line = formatWidgetLine(count, spinnerFrame, fg(ctx));
		if (line === lastLine) return;
		lastLine = line;
		ctx.ui.setWidget(WIDGET_KEY, [line]);
	};

	const dropWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		lastLine = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	// The tick exists only while an episode is live. It advances the spinner
	// once per interval and pushes the line only when state is dirty, so an
	// idle-but-live episode (quiet thinking) still animates without rendering
	// more than the spinner needs.
	let tickTimer: { unref?: () => void } | undefined;
	const startTick = () => {
		if (tickTimer) return;
		tickTimer = setInterval_(() => {
			if (!episodeLive) {
				clearInterval_(tickTimer);
				tickTimer = undefined;
				return;
			}
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			push();
		}, TICK_INTERVAL_MS);
		tickTimer.unref?.();
	};
	const stopTick = () => {
		if (!tickTimer) return;
		clearInterval_(tickTimer);
		tickTimer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
	});

	pi.on("message_update", (event, ctx) => {
		if (!isAssistant(event.message)) return;
		const hasThinking = event.message.content.some((block) => block.type === "thinking");
		if (!hasThinking) return;
		ctxRef = ctx;
		count = estimateThinkingTokens(event.message);
		dirty = true;
		if (!episodeLive) {
			episodeLive = true;
			startTick();
			// First token: show the widget immediately instead of waiting a tick.
			push();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!isAssistant(event.message) || !episodeLive) return;
		// Freeze the exact count when the provider reports one; otherwise keep
		// the streamed estimate, then publish and disappear.
		const exact = exactReasoningTokens(event.message);
		const finalCount = exact ?? estimateThinkingTokens(event.message);
		pi.events.emit(THINKING_TOKENS_EVENT, {
			reasoningTokens: finalCount,
			exact: exact !== undefined,
		} satisfies ThinkingEpisodeEvent);
		episodeLive = false;
		dirty = false;
		stopTick();
		dropWidget(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		// Safety net: a stream that never reached message_end (abort, error)
		// must not leave a stale widget or a ticking timer behind.
		episodeLive = false;
		dirty = false;
		stopTick();
		if (lastLine !== undefined) dropWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTick();
		dropWidget(ctx);
	});
}
