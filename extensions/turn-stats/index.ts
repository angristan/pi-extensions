import {
	calculateCost,
	type AssistantMessage,
	type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "turn-stats";

// Minimum token-window before context-% becomes meaningful. Matches the footer's
// baseline so the two views don't drift apart.
interface RunUsage {
	/** Sum across every assistant message produced during this agent run. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface ResponseTiming {
	requestStartedAt: number;
	firstTokenAt?: number;
	endedAt?: number;
	outputTokens?: number;
	ttftMs?: number;
	tokensPerSecond?: number;
}

interface CompletionEntry {
	startedAt: number;
	endedAt: number;
	elapsedMs: number;
	timing?: ResponseTiming;
	usage?: RunUsage;
	cacheHitPercent?: number;
}

function formatClock(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	})
		.format(timestamp)
		.toLowerCase();
}

export function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
	if (totalSeconds < 1) return "<1s";
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

/** Compact token count, e.g. `1.2k`, `3.4M`. Kept in sync with the footer's view. */
function formatTokensCompact(value: number): string {
	const safe = Math.max(0, Math.trunc(value));
	if (safe === 0) return "0";
	if (safe < 1_000) return String(safe);

	const [scaled, suffix] = safe >= 1_000_000_000
		? [safe / 1_000_000_000, "B"]
		: safe >= 1_000_000
			? [safe / 1_000_000, "M"]
			: [safe / 1_000, "K"];
	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	let formatted = scaled.toFixed(decimals);
	while (formatted.includes(".") && formatted.endsWith("0")) formatted = formatted.slice(0, -1);
	if (formatted.endsWith(".")) formatted = formatted.slice(0, -1);
	return `${formatted}${suffix}`;
}

/** Human-readable latency: `340ms`, `1.20s`, `2.5s`, `3m04s`. */
function formatLatency(milliseconds: number): string {
	const safe = Math.max(0, milliseconds);
	if (safe < 1_000) return `${Math.round(safe)}ms`;
	const seconds = safe / 1_000;
	if (seconds < 10) return `${seconds.toFixed(2)}s`;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, "0");
	return `${minutes}m${remainingSeconds}s`;
}

/** Throughput, e.g. `42.5/s`, `120/s`. */
function formatTokensPerSecond(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0/s";
	if (value < 10) return `${value.toFixed(1)}/s`;
	if (value < 100) return `${value.toFixed(0)}/s`;
	return `${formatTokensCompact(value)}/s`;
}

/** Cost rounded to cents, with a sub-cent floor so tiny turns don't show `$0.00`. */
function formatCostCents(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost < 0.01) return "<$0.01";
	const cents = Math.round((cost + Number.EPSILON) * 100) / 100;
	return `$${cents.toFixed(2)}`;
}

/**
 * First-output detection for TTFT.
 *
 * Pi surfaces semantic stream events rather than raw provider token callbacks.
 * Treat the first content-block boundary as the first token, with delta/end
 * fallbacks for providers that never emit explicit start events for a block.
 */
function isFirstOutputEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return true;
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}

function finalizeResponseTiming(
	timing: ResponseTiming,
	message: AssistantMessage,
	endedAt: number,
): ResponseTiming {
	const outputTokens = Math.max(0, message.usage?.output ?? 0);
	const firstTokenAt = timing.firstTokenAt;
	// Throughput is measured from the first token (not the request start, which
	// would under-report during a long TTFT). Fall back to request start if the
	// provider never emitted a recognizable first-output event.
	const throughputStartAt = firstTokenAt ?? timing.requestStartedAt;
	const generationMs = Math.max(0, endedAt - throughputStartAt);
	const tokensPerSecond = outputTokens > 0 && generationMs > 0
		? outputTokens / (generationMs / 1_000)
		: undefined;

	return {
		...timing,
		endedAt,
		outputTokens,
		ttftMs: firstTokenAt === undefined ? undefined : Math.max(0, firstTokenAt - timing.requestStartedAt),
		tokensPerSecond,
	};
}

/** Accumulate one finalized assistant message into the running per-turn totals. */
function accumulateUsage(run: RunUsage, message: AssistantMessage, resolvedCost: number): void {
	const usage = message.usage;
	if (!usage) return;
	run.input += Math.max(0, usage.input ?? 0);
	run.output += Math.max(0, usage.output ?? 0);
	run.cacheRead += Math.max(0, usage.cacheRead ?? 0);
	run.cacheWrite += Math.max(0, usage.cacheWrite ?? 0);
	const recordedCost = Math.max(0, usage.cost?.total ?? 0);
	run.cost += recordedCost > 0 ? recordedCost : Math.max(0, resolvedCost);
}

export default function (pi: ExtensionAPI) {
	// First start across retries/compaction/continuations so the entry covers the
	// full user-visible run, matching the original "Worked for X" semantics.
	let startedAt: number | undefined;

	// Per-run timing. `activeResponseTiming` covers the request -> first-token ->
	// message_end lifecycle of a single provider call; `latestResponseTiming` holds
	// the most recent finalized timing so a retry-dominating last message still wins.
	let activeResponseTiming: ResponseTiming | undefined;
	let latestResponseTiming: ResponseTiming | undefined;
	let runUsage: RunUsage | undefined;

	pi.registerEntryRenderer<CompletionEntry>(ENTRY_TYPE, (entry: any, _options: any, theme: any) => {
		const data = entry.data as CompletionEntry;

		// Group-level separator: a thin vertical bar between logical chunks so the
		// eye can chunk the row (duration · throughput · tokens · cache · cost)
		// instead of reading a flat wall of `·`-separated parts.
		const groupSep = theme.fg("dim", " │ ");
		const groups: string[] = [];

		// ── Duration: ◷ <elapsed>  <clock> ──────────────────────────────────────
		// ◷ + clock implies "finished at" without spelling it out.
		groups.push(
			`${theme.fg("muted", "◷")} ${theme.fg("success", formatDuration(data.elapsedMs))} ${theme.fg("muted", formatClock(data.endedAt))}`,
		);

		// ── Throughput: ttft + tps for the last finalized provider response ────────
		// We render the last response rather than averaging because ttft/tps are
		// inherently per-request and an average across retries would be misleading.
		const timing = data.timing;
		if (timing) {
			const bits: string[] = [];
			if (timing.ttftMs !== undefined) bits.push(`${theme.fg("muted", "ttft")} ${theme.fg("thinkingText", formatLatency(timing.ttftMs))}`);
			if (timing.tokensPerSecond !== undefined) bits.push(`${theme.fg("muted", "tps")} ${theme.fg("thinkingText", formatTokensPerSecond(timing.tokensPerSecond))}`);
			if (bits.length > 0) groups.push(bits.join(theme.fg("dim", "  ")));
		}

		// ── Tokens: ↓in (cached) ↑out, matching the footer's arrow convention ─────
		const usage = data.usage;
		if (usage && (usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0)) {
			const cacheColor = (data.cacheHitPercent ?? 0) >= 50 ? "success" : "warning";
			// Input + cache detail as one group.
			const inputBits: string[] = [];
			inputBits.push(`${theme.fg("muted", "↓")} ${theme.fg("text", formatTokensCompact(usage.input))}`);
			if (usage.cacheRead > 0) inputBits.push(`${theme.fg("muted", "cached")} ${theme.fg(cacheColor, formatTokensCompact(usage.cacheRead))}`);
			if (usage.cacheWrite > 0) inputBits.push(`${theme.fg("muted", "written")} ${theme.fg(cacheColor, formatTokensCompact(usage.cacheWrite))}`);
			if (data.cacheHitPercent !== undefined) inputBits.push(`${theme.fg("muted", "hit")} ${theme.fg(cacheColor, `${data.cacheHitPercent.toFixed(0)}%`)}`);
			if (inputBits.length > 0) groups.push(inputBits.join(theme.fg("dim", "  ")));
			// Output as its own group so the │ separator separates it from cache.
			if (usage.output > 0) groups.push(`${theme.fg("muted", "↑")} ${theme.fg("text", formatTokensCompact(usage.output))}`);
		}

		// ── Cost: run's marginal cost in accent (the interesting per-turn metric) ──
		if (usage && usage.cost > 0) {
			groups.push(`${theme.fg("accent", formatCostCents(usage.cost))}`);
		}

		return new Text(groups.join(groupSep), 1, 0);
	});

	const resetResponseTiming = () => {
		activeResponseTiming = undefined;
		latestResponseTiming = undefined;
	};

	pi.on("session_start", () => {
		startedAt = undefined;
		resetResponseTiming();
		runUsage = undefined;
	});

	pi.on("agent_start", () => {
		// Preserve the first start across retries, compaction, and automatic
		// continuations so the entry covers the complete user-visible run.
		startedAt ??= Date.now();
		// A new agent run starts fresh per-run accounting. Retries/continuations
		// within the same run accumulate into the same `runUsage`.
		if (!runUsage) runUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	});

	pi.on("before_provider_request", () => {
		// Mark the start of a provider request so TTFT can be measured at the next
		// first-output event. We do not clear `latestResponseTiming` here: if this
		// request is a retry that never streams a new first token (e.g. an immediate
		// error), the previously finalized timing still represents the last good
		// response and we keep it rather than showing a blank timing.
		activeResponseTiming = { requestStartedAt: Date.now() };
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		if (!activeResponseTiming) return;
		// Record the first output event so `message_end` can compute the finalized
		// ttft. We intentionally do not finalize tps here mid-stream; the completion
		// row is only rendered once the whole run settles.
		if (activeResponseTiming.firstTokenAt === undefined && isFirstOutputEvent(event.assistantMessageEvent)) {
			activeResponseTiming.firstTokenAt = Date.now();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = event.message as AssistantMessage;

		// Finalize timing for this provider response.
		const endedAt = Date.now();
		latestResponseTiming = finalizeResponseTiming(
			activeResponseTiming ?? { requestStartedAt: endedAt },
			message,
			endedAt,
		);
		activeResponseTiming = undefined;

		// Accumulate tokens/cost for the run. Older messages may carry zero cost
		// because their custom model had no rates configured when recorded; resolve
		// the model from the registry and recompute cost in that case.
		if (!runUsage) runUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const resolvedCost = resolveMissingCost(ctx, message);
		accumulateUsage(runUsage, message, resolvedCost);
	});

	pi.on("agent_settled", () => {
		const endedAt = Date.now();
		const effectiveStartedAt = startedAt ?? endedAt;

		// Cache hit rate for the whole run: cacheRead over the full prompt volume
		// (fresh input + cache read + cache write) that was sent to the model.
		const usage = runUsage;
		const promptVolume = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
		const cacheHitPercent = usage && promptVolume > 0
			? (usage.cacheRead / promptVolume) * 100
			: undefined;

		pi.appendEntry(ENTRY_TYPE, {
			startedAt: effectiveStartedAt,
			endedAt,
			elapsedMs: Math.max(0, endedAt - effectiveStartedAt),
			timing: latestResponseTiming,
			usage,
			cacheHitPercent,
		} satisfies CompletionEntry);

		// Reset for the next user-visible run.
		startedAt = undefined;
		resetResponseTiming();
		runUsage = undefined;
	});

	pi.on("session_shutdown", () => {
		startedAt = undefined;
		resetResponseTiming();
		runUsage = undefined;
	});
}

/**
 * Re-derive cost for messages that were recorded with zero cost because their
 * custom model had no rates configured at capture time. Mirrors the footer's
 * `currentUsageTotals` resolver so the run cost and footer session cost agree.
 */
function resolveMissingCost(ctx: any, message: AssistantMessage): number {
	const provider = (message as any).provider;
	const modelId = (message as any).model;
	if (!provider || !modelId || !ctx?.modelRegistry?.find) return 0;
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) return 0;
	const usage = message.usage;
	const calculatedUsage = {
		...usage,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return calculateCost(model, calculatedUsage as any).total;
}
