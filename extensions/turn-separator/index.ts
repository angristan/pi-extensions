/**
 * turn-separator — dim full-width rule between turns, optionally labeled with
 * how long the assistant worked.
 *
 * After each agent run settles, appends a custom (non-LLM) entry rendered as a
 * single full-width `─` line, dimmed via the theme's `dim`/`mdHr` token. When
 * the turn took longer than 60s, a centered `─ Worked for Xm ──────` label is
 * shown — mirroring the transcript separator in other terminal agents. Only
 * turns that performed concrete work (ran at least one tool) get a separator;
 * purely conversational turns do not.
 */
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "turn-separator";
/** Only label turns longer than this (seconds) — short turns get a bare rule. */
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
		// `─ <label> ─` centered: label sits at the left with a trailing rule
		// filling the remaining width, matching the reference rendering.
		const labeled = `─ ${this.label} ─`;
		const labeledWidth = labeled.length;
		const fill = "─".repeat(Math.max(0, w - labeledWidth));
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
		// Centered label only for long turns, matching the reference behavior.
		const label = elapsed > LABEL_THRESHOLD_SECONDS
			? `Worked for ${formatElapsed(elapsed)}`
			: undefined;
		return new RuleLine(dim, label);
	});

	let runStartedAt: number | undefined;
	let didToolWork = false;

	pi.on("agent_start", () => {
		runStartedAt = Date.now();
		didToolWork = false;
	});
	// Any tool execution marks the turn as having done concrete work.
	pi.on("tool_execution_start", () => {
		didToolWork = true;
	});
	// turn_end fires exactly once per turn (covering all retries/tool loops),
	// unlike agent_settled which fires per provider response and stacks rules
	// mid-turn.
	pi.on("turn_end", () => {
		// Only separate turns that performed work; conversational turns skip the
		// divider so the transcript doesn't accumulate empty rules.
		if (!didToolWork) return;
		const elapsedSeconds = runStartedAt
			? (Date.now() - runStartedAt) / 1000
			: undefined;
		pi.appendEntry(ENTRY_TYPE, { elapsedSeconds });
	});
}
