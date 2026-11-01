import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WidthAwareLines } from "./diff.js";

const darkPalette = { mode: "dark" as const, addBackground: "\x1b[48;2;33;58;43m", deleteBackground: "\x1b[48;2;74;34;29m" };

describe("WidthAwareLines", () => {
	// Pi exits when any rendered row is wider than the terminal, so every row
	// must fit even when the viewport is narrower than the diff gutter.
	test("keeps diff rows within very narrow viewports", () => {
		const lines = ["     1 +# Container image", "    12 -removed line", "    13  context line"];
		for (const palette of [undefined, darkPalette]) {
			for (let width = 1; width <= 12; width++) {
				const rows = new WidthAwareLines(lines, palette).render(width);
				expect(rows.length).toBeGreaterThan(0);
				for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			}
		}
	});
});
