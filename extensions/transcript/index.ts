import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveTranscriptOverlayHeight, TRANSCRIPT_OVERLAY_OPTIONS, TranscriptPager } from "./pager.js";

export {
	resolveTranscriptOverlayHeight,
	TRANSCRIPT_OVERLAY_OPTIONS,
	TranscriptPager,
	type TranscriptEntry,
	type TranscriptPagerOptions,
} from "./pager.js";

export default function (pi: ExtensionAPI) {
	const showTranscript = async (ctx: any) => {
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) =>
			new TranscriptPager(() => ctx.sessionManager.getBranch(), theme, () => tui.requestRender(), done, {
				maxHeight: () => resolveTranscriptOverlayHeight(tui.terminal.rows),
			}), {
			overlay: true,
			overlayOptions: TRANSCRIPT_OVERLAY_OPTIONS,
		});
	};

	pi.registerCommand("transcript", { description: "Open a full scrollable transcript", handler: async (_args, ctx) => showTranscript(ctx) });
	pi.registerShortcut("ctrl+shift+t", { description: "Open full transcript", handler: showTranscript });
}
