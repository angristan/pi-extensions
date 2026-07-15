import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Render a local path as an OSC 8 file hyperlink without changing its width. */
export function hyperlinkPath(display: string, path: string, cwd = process.cwd()): string {
	try {
		const absolute = isAbsolute(path) ? path : resolve(cwd, path);
		return hyperlink(display, pathToFileURL(absolute).toString());
	} catch {
		return display;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("open-path", {
		description: "Show a clickable file path",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) {
				ctx.ui.notify("Usage: /open-path <path>", "warning");
				return;
			}
			ctx.ui.notify(hyperlinkPath(path, path, ctx.cwd), "info");
		},
	});
}
