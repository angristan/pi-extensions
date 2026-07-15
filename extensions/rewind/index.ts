import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n");
}

// Shared handler: pick an earlier user prompt, fork the session before it,
// and restore that prompt to the editor so you can take a different path.
async function rewindHandler(_args: string, ctx: any) {
	const candidates = ctx.sessionManager.getBranch().flatMap((entry: any) => {
		if (entry.type !== "message" || entry.message?.role !== "user") return [];
		const text = contentText(entry.message.content).trim();
		return text ? [{ entry, text }] : [];
	}).reverse();
	if (!candidates.length) return ctx.ui.notify("No earlier user prompts found.", "info");
	const labels = candidates.map(({ text }: any, index: number) => `${index + 1}. ${text.replace(/\s+/g, " ").slice(0, 100)}`);
	const selected = await ctx.ui.select("Rewind to which prompt?", labels);
	const index = selected ? labels.indexOf(selected) : -1;
	if (index < 0) return;
	const target = candidates[index];
	const confirmed = await ctx.ui.confirm("Fork conversation?", "The current session is preserved. A new fork will start before this prompt.");
	if (!confirmed) return;
	await ctx.fork(target.entry.id, {
		position: "before",
		withSession: async (fresh: any) => fresh.ui.setEditorText(target.text),
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rewind", {
		description: "Fork from an earlier user prompt and restore it to the editor",
		handler: rewindHandler,
	});
	// /undo is an alias — same behavior, easier to type/match muscle memory.
	pi.registerCommand("undo", {
		description: "Alias for /rewind — fork from an earlier user prompt",
		handler: rewindHandler,
	});
}
