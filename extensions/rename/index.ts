import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rename", {
		description: "Set session display name (alias for /name)",
		handler: (args, ctx) => {
			const name = args.trim();
			if (!name) {
				const currentName = pi.getSessionName();
				ctx.ui.notify(
					currentName ? `Session name: ${currentName}` : "Usage: /rename <name>",
					currentName ? "info" : "warning",
				);
				return;
			}

			pi.setSessionName(name);
			const normalizedName = pi.getSessionName();
			if (normalizedName !== name) {
				ctx.ui.notify(
					`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(normalizedName)}`,
					"warning",
				);
			}
			ctx.ui.notify(`Session name set: ${normalizedName ?? name}`, "info");
		},
	});
}
