import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT =
	"Automatic context compaction completed. Continue the current task from the compacted summary. " +
	"Do not repeat completed work. If the task is already fully complete, state that briefly instead.";

/**
 * Pi intentionally stops after threshold-triggered auto-compaction. Queueing a
 * hidden follow-up from session_compact lets Pi's existing post-run loop call
 * agent.continue() after the compacted context has been installed.
 *
 * Overflow recovery already retries natively, and manual /compact should remain
 * user-controlled, so neither path is changed here.
 */
export default function (pi: ExtensionAPI) {
	pi.on("session_compact", (event, ctx) => {
		if (event.reason !== "threshold" || event.willRetry) return;

		// Threshold compaction may also run as preflight for a newly submitted
		// user prompt. That prompt already continues the session, so only inject
		// a follow-up while the previous agent run is still active.
		if (ctx.isIdle()) return;

		pi.sendMessage(
			{
				customType: "auto-compact-continue",
				content: CONTINUE_PROMPT,
				display: false,
				details: { reason: event.reason },
			},
			{
				triggerTurn: true,
				deliverAs: "followUp",
			},
		);
	});
}
