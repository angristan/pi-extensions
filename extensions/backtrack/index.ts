import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function contentText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("backtrack", {
		description: "Fork from an earlier user prompt and restore it to the editor",
		handler: async (_args, ctx) => {
			const candidates = ctx.sessionManager.getBranch().flatMap((entry: any) => {
				if (entry.type !== "message" || entry.message?.role !== "user") return [];
				const text = contentText(entry.message.content).trim();
				return text ? [{ entry, text }] : [];
			}).reverse();
			if (!candidates.length) return ctx.ui.notify("No earlier user prompts found.", "info");
			const labels = candidates.map(({ text }: any, index: number) => `${index + 1}. ${text.replace(/\s+/g, " ").slice(0, 100)}`);
			const selected = await ctx.ui.select("Backtrack to which prompt?", labels);
			const index = selected ? labels.indexOf(selected) : -1;
			if (index < 0) return;
			const target = candidates[index];
			const confirmed = await ctx.ui.confirm("Fork conversation?", "The current session is preserved. A new fork will start before this prompt.");
			if (!confirmed) return;
			await ctx.fork(target.entry.id, {
				position: "before",
				withSession: async (fresh) => fresh.ui.setEditorText(target.text),
			});
		},
	});
}
