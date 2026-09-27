/**
 * Helpers for hidden "anchor" messages that restate extension state (a goal, a
 * plan) for the model.
 *
 * Extensions that keep only their latest anchor in model context pay for every
 * new anchor twice: the new message itself, and a prompt-cache miss from the
 * position of the pruned older anchor onward. Restore paths (startup, resume,
 * reload, tree navigation) must therefore skip re-anchoring when the model
 * already sees the same state since the last compaction.
 */

/** Plain text of a message or custom-message content payload. */
export function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.filter((part: any) => part?.type === "text" && typeof part.text === "string");
	return parts.length === content.length ? parts.map((part: any) => part.text).join("") : undefined;
}

/** Text of a persisted hidden custom message of the given type. */
export function customMessageText(entry: any, customType: string): string | undefined {
	if (entry?.type !== "custom_message" || entry.customType !== customType) return undefined;
	return contentText(entry.content);
}

/**
 * Return the text of the newest anchor on the branch, scanning backwards and
 * stopping at the latest compaction. Anything before that compaction may only
 * survive as summary text, so it never counts as a current anchor.
 *
 * `anchorText` maps an entry to the state text it conveys to the model, or
 * `undefined` when the entry is not an anchor.
 */
export function latestAnchorText(
	entries: readonly any[],
	anchorText: (entry: any) => string | undefined,
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction") return undefined;
		const text = anchorText(entry);
		if (text !== undefined) return text;
	}
	return undefined;
}
