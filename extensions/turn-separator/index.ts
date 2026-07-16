/**
 * turn-separator — dim full-width rule between assistant messages that follow
 * tool work, so each step of a multi-step turn is visually separated.
 *
 * Emits a custom (non-LLM) entry rendered as a single full-width dim `─` line
 * (theme's `dim` token), with a centered `─ Worked for Xm ─` label for steps
 * longer than 60s. The separator is appended when a new assistant message
 * starts AND the preceding step performed concrete work (ran a tool) — so
 * conversational-only steps don't accumulate empty rules. This mirrors the
 * transcript separator pattern used by other terminal agents, where the rule
 * is drawn before a streamed assistant message that follows exec/patch/MCP
 * activity.
 */
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, MessageStartEvent } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "turn-separator";
/** Only label steps longer than this (seconds) — short steps get a bare rule. */
const LABEL_THRESHOLD_SECONDS = 60;

interface SeparatorData {
	elapsedSeconds?: number;
}

/** A full-width dim `─` rule, optionally with a centered label. */
class RuleLine implements Component {
	constructor(
		private readonly dim: (s: string) => string,
		private readonly label?: string,
	) {}
	render(width: number): string[] {
		const w = Math.max(0, width);
		if (!this.label) return [this.dim("─".repeat(w))];
		// `─ <label> ─` left-aligned with a trailing rule filling the rest,
		// matching the reference rendering.
		const labeled = `─ ${this.label} ─`;
		const fill = "─".repeat(Math.max(0, w - labeled.length));
		return [this.dim(`${labeled}${fill}`)];
	}
}

function formatElapsed(seconds: number): string {
	if (seconds >= 60) {
		const m = Math.floor(seconds / 60);
		const s = Math.round(seconds % 60);
		return s > 0 ? `${m}m ${s}s` : `${m}m`;
	}
	return `${Math.round(seconds)}s`;
}

export default function turnSeparator(pi: ExtensionAPI) {
	pi.registerEntryRenderer(ENTRY_TYPE, (entry: any, _options: any, theme: any) => {
		const dim = (s: string) =>
			typeof theme?.fg === "function" ? theme.fg("dim", s) : s;
		const data = (entry.data ?? {}) as SeparatorData;
		const elapsed = data.elapsedSeconds ?? 0;
		const label = elapsed > LABEL_THRESHOLD_SECONDS
			? `Worked for ${formatElapsed(elapsed)}`
			: undefined;
		return new RuleLine(dim, label);
	});

	// Track the previous step's work + timing so we can emit a separator before
	// a new assistant message only when the prior step did concrete work.
	let prevStepDidWork = false;
	let prevStepStartedAt: number | undefined;
	let currentStepStartedAt: number | undefined;

	pi.on("message_start", (event: MessageStartEvent) => {
		// Only assistant messages trigger a separator (tool results and user
		// messages are not separator points).
		if (event.message.role !== "assistant") return;
		// Promote the current step to "previous" before resetting for this new
		// assistant message.
		prevStepStartedAt = currentStepStartedAt;
		// Emit before this assistant message starts, if the prior step did work.
		if (prevStepDidWork && prevStepStartedAt !== undefined) {
			const elapsedSeconds = (Date.now() - prevStepStartedAt) / 1000;
			pi.appendEntry(ENTRY_TYPE, { elapsedSeconds });
		}
		// Reset for this new step.
		prevStepDidWork = false;
		currentStepStartedAt = Date.now();
	});
	// Any tool execution marks the current step as having done concrete work,
	// so the next assistant message gets a separator before it.
	pi.on("tool_execution_start", () => {
		prevStepDidWork = true;
		// Anchor the step's start to the first tool call if we never saw a
		// message_start (defensive: should not normally happen).
		prevStepStartedAt ??= Date.now();
	});
}
