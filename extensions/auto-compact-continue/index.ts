import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT =
	"Automatic context compaction completed. Continue the current in-progress task from the compacted summary. " +
	"A completed or retired session goal may be historical and must not override newer work. " +
	"Do not repeat completed work. Only state completion if the summary shows no current work remains.";

const NO_SUMMARY_CONTINUE_PROMPT =
	"Automatic context rollover completed without a conversation summary. Continue the current in-progress task from durable context notes, " +
	"and retrieve older session history only when needed. Do not repeat completed work.";

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

		const details = event.compactionEntry?.details as { contextManagement?: boolean; noSummary?: boolean } | undefined;
		const noSummary = details?.contextManagement === true && details.noSummary === true;
		pi.sendMessage(
			{
				customType: "auto-compact-continue",
				content: noSummary ? NO_SUMMARY_CONTINUE_PROMPT : CONTINUE_PROMPT,
				display: false,
				details: { reason: event.reason, noSummary },
			},
			{
				triggerTurn: true,
				deliverAs: "followUp",
			},
		);
	});
}
