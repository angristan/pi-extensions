import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT =
	"Automatic context compaction completed. Continue the current in-progress task from the compacted summary. " +
	"A completed or retired session goal may be historical and must not override newer work. " +
	"Do not repeat completed work. Only state completion if the summary shows no current work remains.";

const NO_SUMMARY_CONTINUE_PROMPT =
	"Automatic context rollover completed without a conversation summary. Continue the current in-progress task from durable context notes, " +
	"and retrieve older session history only when needed. Do not repeat completed work.";

interface PendingContinuation {
	compactionEntryId: string;
	noSummary: boolean;
}

function entryIndex(entries: readonly any[], id: string): number {
	return entries.findIndex((entry) => entry?.id === id);
}

function latestAssistantBefore(entries: readonly any[], index: number): any | undefined {
	for (let current = index - 1; current >= 0; current -= 1) {
		const entry = entries[current];
		if (entry?.type === "message" && entry.message?.role === "assistant") return entry.message;
	}
	return undefined;
}

function hasAssistantAfter(entries: readonly any[], index: number): boolean {
	return entries.slice(index + 1).some((entry) =>
		entry?.type === "message" && entry.message?.role === "assistant",
	);
}

/**
 * Threshold compaction can interrupt a tool-use turn before its next assistant
 * response. Pi normally resumes that turn itself. Wait until the run settles
 * before adding a fallback continuation so a native response can never leave a
 * stale follow-up queued behind the completed task.
 *
 * Overflow recovery already retries natively, final assistant responses are
 * complete, and manual /compact should remain user-controlled.
 */
export default function (pi: ExtensionAPI) {
	let pending: PendingContinuation | undefined;

	pi.on("session_compact", (event, ctx) => {
		if (event.reason !== "threshold" || event.willRetry || ctx.isIdle()) return;

		const compactionEntryId = event.compactionEntry?.id;
		if (typeof compactionEntryId !== "string") return;
		const entries = ctx.sessionManager.getBranch();
		const index = entryIndex(entries, compactionEntryId);
		const assistant = index < 0 ? undefined : latestAssistantBefore(entries, index);
		if (assistant?.stopReason !== "toolUse") return;

		const details = event.compactionEntry.details as { contextManagement?: boolean; noSummary?: boolean } | undefined;
		pending = {
			compactionEntryId,
			noSummary: details?.contextManagement === true && details.noSummary === true,
		};
	});

	pi.on("agent_settled", (_event, ctx) => {
		const continuation = pending;
		pending = undefined;
		if (!continuation) return;

		const entries = ctx.sessionManager.getBranch();
		const index = entryIndex(entries, continuation.compactionEntryId);
		if (index < 0 || hasAssistantAfter(entries, index)) return;

		pi.sendMessage(
			{
				customType: "auto-compact-continue",
				content: continuation.noSummary ? NO_SUMMARY_CONTINUE_PROMPT : CONTINUE_PROMPT,
				display: false,
				details: { reason: "threshold", noSummary: continuation.noSummary },
			},
			{ triggerTurn: true },
		);
	});
}
