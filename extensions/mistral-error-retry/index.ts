import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Text Pi's Mistral adapter emits when a stream ends with `finish_reason: "error"`.
 * The model server aborted generation without detail, which is usually transient,
 * but Pi's retry classifier does not recognize this wording.
 */
export const MISTRAL_STREAM_ERROR = "Provider stopped with: error";

/**
 * Replacement text. "server error" matches Pi's built-in retryable pattern, so Pi's
 * normal auto-retry (backoff, cancel, and status rows) handles the turn.
 */
export const RETRYABLE_MISTRAL_STREAM_ERROR = `${MISTRAL_STREAM_ERROR} (server error)`;

/**
 * Consecutive failures to mark retryable. A checkpoint that fails deterministically
 * would otherwise use the whole `retry.maxRetries` budget, which can be large.
 */
export const MAX_CONSECUTIVE_RETRIES = 3;

export default function (pi: ExtensionAPI) {
	let consecutive = 0;

	// A new user prompt starts a fresh budget even if the previous one ran out.
	pi.on("input", () => {
		consecutive = 0;
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error" || message.errorMessage !== MISTRAL_STREAM_ERROR) {
			// Any other outcome, including a successful retry, resets the budget.
			consecutive = 0;
			return;
		}
		if (consecutive >= MAX_CONSECUTIVE_RETRIES) return;
		consecutive++;
		return { message: { ...message, errorMessage: RETRYABLE_MISTRAL_STREAM_ERROR } };
	});
}
