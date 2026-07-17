/**
 * turn-separator — dim full-width rule between assistant messages that follow
 * tool work, so each step of a multi-step turn is visually separated.
 *
 * Emits a custom (non-LLM) entry rendered as a single dim `─` line (theme's
 * `dim` token), with a `─ Worked for Xm ─` label for steps longer than 60s.
 * The separator is appended when a new assistant message starts AND the
 * preceding step performed concrete work (ran a tool). The rendered rule leaves
 * a tiny right margin because terminals can wrap full-width styled rows into a
 * stray `──` line.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "turn-separator";
/** Only label steps longer than this (seconds); short steps get a bare rule. */
const LABEL_THRESHOLD_SECONDS = 60;

interface SeparatorData {
	elapsedSeconds?: number;
}

/** A dim `─` rule, optionally with a label, with slack to avoid terminal wrap. */
class RuleLine implements Component {
	constructor(
		private readonly dim: (s: string) => string,
		private readonly label?: string,
	) {}
	render(width: number): string[] {
		// Do not fill the last terminal columns. In some terminals a styled line at
		// exact width wraps and leaves a stray `──` row, which looked like an empty
		// turn/separator block.
		const w = Math.max(0, width - 2);
		if (w <= 0) return [];
		if (!this.label) return [this.dim("─".repeat(w))];

		const labeled = `─ ${this.label} ─`;
		const fill = "─".repeat(Math.max(0, w - visibleWidth(labeled)));
		return [this.dim(truncateToWidth(`${labeled}${fill}`, w, ""))];
	}
	invalidate(): void {}
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
	pi.registerEntryRenderer<SeparatorData>(ENTRY_TYPE, (entry: any, _options: any, theme: any) => {
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

	pi.on("message_start", (event) => {
		// Only assistant messages trigger a separator (tool results and user
		// messages are not separator points).
		if (event.message.role !== "assistant") return;
		// Promote the current step to "previous" before resetting for this new
		// assistant message.
		prevStepStartedAt = currentStepStartedAt;
		// Emit before this assistant message starts, if the prior step did work.
		if (prevStepDidWork && prevStepStartedAt !== undefined) {
			const elapsedSeconds = (Date.now() - prevStepStartedAt) / 1000;
			pi.appendEntry<SeparatorData>(ENTRY_TYPE, { elapsedSeconds });
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
