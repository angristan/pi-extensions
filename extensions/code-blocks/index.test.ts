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

const parentStyle = {
	color: (text: string) => `\x1b[38;2;200;200;200m${text}\x1b[39m`,
	italic: true,
};
const styledTheme = {
	...theme,
	italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
};

function styledCodeRow(highlighted: string): string {
	const lines = renderCodeBlock("ignored", "ts", 80, {
		...styledTheme,
		highlightCode: () => [highlighted],
	}, { defaultTextStyle: parentStyle });
	return lines[1];
}

test("dims basic and bright ANSI foreground colors in styled code", () => {
	expect(styledCodeRow("\x1b[31mred\x1b[94mblue")).toContain(
		"\x1b[38;2;77;0;0mred\x1b[38;2;0;0;153mblue",
	);
});

test("converts 256-color ANSI foregrounds to dimmed true color", () => {
	expect(styledCodeRow("\x1b[38;5;196mred")).toContain("\x1b[38;2;153;0;0mred");
});

test("dims true-color ANSI foregrounds channel by channel", () => {
	expect(styledCodeRow("\x1b[38;2;100;150;200mvalue")).toContain(
		"\x1b[38;2;60;90;120mvalue",
	);
});

test("reapplies the parent style after syntax-highlighter resets", () => {
	const row = styledCodeRow("\x1b[31mred\x1b[0m gap");
	const parentPrefix = "\x1b[3m\x1b[38;2;200;200;200m";

	expect(row).toStartWith(parentPrefix);
	expect(row).toContain(`\x1b[0m${parentPrefix} gap`);
	expect(row).toEndWith("\x1b[39m\x1b[23m");
});

test("leaves incomplete extended-color sequences intact", () => {
	const row = styledCodeRow("\x1b[38;2;255mvalue");

	expect(row).toContain("\x1b[38;2;255mvalue");
	expect(row).not.toContain("NaN");
});
