import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCodeBox } from "./index";

const theme = {
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	highlightCode: (code: string) => code.split("\n"),
};

test("renders a width-safe bordered block with a normalized language label", () => {
	const lines = renderCodeBox("const value = 123456789;\nreturn value;", "ts extra", 18, theme);

	expect(lines[0]).toContain(" ts ");
	expect(lines[0]).not.toContain("extra");
	expect(lines.at(-1)).toStartWith("╰");
	expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
	expect(lines.length).toBeGreaterThan(4);
});

test("bounds tall blocks with a caller-provided omission row", () => {
	const lines = renderCodeBox("one\ntwo\nthree\nfour", "", 20, theme, {
		maxRows: 3,
		renderOmission: (omitted) => `omitted ${omitted}`,
	});

	expect(lines).toHaveLength(5);
	expect(lines.join("\n")).toContain("omitted 2");
});

test("uses unframed code in panes too narrow for a useful box", () => {
	expect(renderCodeBox("a\nb", "js", 7, theme)).toEqual(["a", "b"]);
});
