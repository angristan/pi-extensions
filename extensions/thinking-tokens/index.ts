/**
 * thinking-tokens — live token counts on Pi's collapsed thinking labels.
 *
 * Pi renders every hidden thinking block as a static "Thinking..." label with
 * no progress signal. This extension turns that label into a live counter
 * (`Thinking… 1.2k`) while reasoning streams, then freezes the final count on
 * the message when it settles. The frozen count is exact when the provider
 * reports reasoning tokens in its usage payload (Anthropic, OpenAI Responses,
 * Gemini); otherwise the last chars-per-token estimate is kept.
 *
 * The label is global across the transcript, so the counter always reflects the
 * most recent thinking episode. The frozen count stays visible after a run
 * settles — for transcript review — and resets when the next run starts.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STREAMING_LABEL = "Thinking\u2026"; // … while the label is still moving
const FROZEN_LABEL = "Thinking..."; // matches Pi's default label style
const CHARS_PER_TOKEN = 4;

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

export function formatLabel(count: number, streaming: boolean): string {
	const head = streaming ? STREAMING_LABEL : FROZEN_LABEL;
	return count > 0 ? `${head} ${formatTokenCount(count)}` : head;
}

interface RuntimeDependencies {
	/** Injected clock-free label sink for tests. */
	pushLabel?: (ctx: ExtensionContext, label: string | undefined) => void;
}

export default function thinkingTokens(pi: ExtensionAPI, deps: RuntimeDependencies = {}) {
	// runActive distinguishes fresh user-visible runs (reset the label) from
	// internal re-entries (retries, compaction continuations) that keep it.
	let runActive = false;
	let sawThinking = false;
	let lastLabel: string | undefined;

	const push = (ctx: ExtensionContext, label: string | undefined) => {
		if (ctx.mode !== "tui" || label === lastLabel) return;
		lastLabel = label;
		(deps.pushLabel ?? ((context, value) => context.ui.setHiddenThinkingLabel(value)))(ctx, label);
	};

	const isAssistant = (message: unknown): message is AssistantMessage =>
		(message as AssistantMessage).role === "assistant";

	pi.on("agent_start", (_event, ctx) => {
		// A fresh run clears the previous episode's frozen count; an internal
		// re-entry keeps it until new thinking streams.
		if (runActive) return;
		runActive = true;
		sawThinking = false;
		push(ctx, undefined);
	});

	pi.on("message_update", (event, ctx) => {
		if (!isAssistant(event.message)) return;
		// Recompute from the partial message every update: block text always
		// reflects everything streamed so far, including interleaved blocks.
		const hasThinking = event.message.content.some((block) => block.type === "thinking");
		if (!hasThinking) return;
		sawThinking = true;
		push(ctx, formatLabel(estimateThinkingTokens(event.message), true));
	});

	pi.on("message_end", (event, ctx) => {
		if (!isAssistant(event.message) || !sawThinking) return;
		// Freeze with the exact count when the provider reports one; otherwise
		// keep the streamed estimate. The plain-dots label marks it settled.
		const count = exactReasoningTokens(event.message) ?? estimateThinkingTokens(event.message);
		push(ctx, formatLabel(count, false));
	});

	pi.on("agent_settled", () => {
		// Keep the frozen count visible for transcript review between runs.
		runActive = false;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Restore Pi's default label so reload/quit never leaks a custom one.
		push(ctx, undefined);
	});
}
