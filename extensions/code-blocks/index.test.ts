import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCodeBlock, renderCodeBox } from "./index";

const theme = {
	codeBlock: (text: string) => text,
	codeBlockBorder: (text: string) => text,
	highlightCode: (code: string) => code.split("\n"),
};

test("renders Markdown code between horizontal rules without decorating code rows", () => {
	const lines = renderCodeBlock("const value = 1;\nreturn value;", "ts extra", 40, theme);

	const codeRows = lines.slice(1, -1);
	expect(lines[0]).toStartWith("── ts ");
	expect(codeRows).toEqual(["const value = 1;", "return value;"]);
	expect(visibleWidth(lines.at(-1)!)).toBe(Math.max(...codeRows.map(visibleWidth)));
	expect(visibleWidth(lines.at(-1)!)).toBeLessThan(40);
	expect(codeRows.every((line) => !/[╭╮│╰╯]/.test(line))).toBe(true);
});

test("uses a generic label when a Markdown fence has no language", () => {
	const lines = renderCodeBlock("one\ntwo", "", 20, theme);

	expect(lines[0]).toStartWith("── code ");
	expect(lines.slice(1, -1)).toEqual(["one", "two"]);
	expect(visibleWidth(lines.at(-1)!)).toBe(12);
});

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
