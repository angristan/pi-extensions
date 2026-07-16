/**
 * turn-separator — draws a full-width horizontal rule between turns.
 *
 * After each assistant turn settles, appends a custom (non-LLM) entry whose
 * renderer returns a DynamicBorder: pi's native full-width `─` rule, themed
 * via `theme.fg("mdHr", ...)` so it respects the active theme and matches
 * markdown horizontal rules. On startup no rule is drawn.
 */
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "turn-separator";

export default function turnSeparator(pi: ExtensionAPI) {
	// DynamicBorder.render(width) returns a single-element array with `─`*width.
	// Color via the theme's hr token so the rule is consistent with markdown `---`.
	pi.registerEntryRenderer(ENTRY_TYPE, (_entry: any, _options: any, theme: any) => {
		const color = (s: string) =>
			typeof theme?.fg === "function" ? theme.fg("mdHr", s) : s;
		return new DynamicBorder(color);
	});

	// Draw the rule after each turn settles. `agent_settled` fires once per
	// complete user-visible run (covers retries, compaction, auto-continue),
	// so the separator lands between exchanges rather than between retries.
	pi.on("agent_settled", () => {
		pi.appendEntry(ENTRY_TYPE);
	});
}
