import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TranscriptPager } from "./pager.js";

export { TranscriptPager, type TranscriptEntry, type TranscriptPagerOptions } from "./pager.js";

export default function (pi: ExtensionAPI) {
	const showTranscript = async (ctx: any) => {
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) =>
			new TranscriptPager(() => ctx.sessionManager.getBranch(), theme, () => tui.requestRender(), done), {
			overlay: true,
			overlayOptions: { width: "95%", maxHeight: "92%", anchor: "center", margin: 1 },
		});
	};

	pi.registerCommand("transcript", { description: "Open a full scrollable transcript", handler: async (_args, ctx) => showTranscript(ctx) });
	pi.registerShortcut("ctrl+shift+t", { description: "Open full transcript", handler: showTranscript });
}
