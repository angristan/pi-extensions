import { describe, expect, test } from "bun:test";
import { colorizeDiff } from "../better-native-pi/diff.js";
import { renderCodeBlock } from "./index.js";
import {
	getSyntaxLanguageFromPath,
	highlightZigCode,
	type SyntaxColor,
	type SyntaxTheme,
} from "./syntax.js";

const ANSI_BY_COLOR: Record<SyntaxColor, number> = {
	mdCodeBlock: 250,
	syntaxComment: 244,
	syntaxKeyword: 141,
	syntaxFunction: 75,
	syntaxVariable: 214,
	syntaxString: 114,
	syntaxNumber: 176,
	syntaxType: 81,
	syntaxOperator: 141,
	syntaxPunctuation: 244,
};

const syntaxTheme: SyntaxTheme = {
	fg: (color, text) => `\x1b[38;5;${ANSI_BY_COLOR[color]}m${text}\x1b[39m`,
};

describe("Zig syntax highlighting", () => {
	test("maps Zig TextMate scopes to Pi semantic theme colors", () => {
		const lines = highlightZigCode([
			"const std = @import(\"std\");",
			"// entry point",
			"pub fn main() !void {",
			"    const count: usize = 42;",
			"}",
		].join("\n"), syntaxTheme);

		expect(lines[0]).toContain("\x1b[38;5;141mconst\x1b[39m");
		expect(lines[0]).toContain("\x1b[38;5;214mstd\x1b[39m");
		expect(lines[0]).toContain("\x1b[38;5;75m@import\x1b[39m");
		expect(lines[0]).toContain("\x1b[38;5;114m\"std\"\x1b[39m");
		expect(lines[1]).toContain("\x1b[38;5;244m// entry point\x1b[39m");
		expect(lines[2]).toContain("\x1b[38;5;75mmain\x1b[39m");
		expect(lines[2]).toContain("\x1b[38;5;81mvoid\x1b[39m");
		expect(lines[3]).toContain("\x1b[38;5;176m42\x1b[39m");
	});

	test("uses Shiki for Zig fences instead of Pi's unsupported fallback", () => {
		const markdownTheme = {
			codeBlock: (text: string) => text,
			codeBlockBorder: (text: string) => text,
			highlightCode: () => { throw new Error("Pi fallback must not handle Zig"); },
		};

		const lines = renderCodeBlock("const value: usize = 1;", "zig", 100, markdownTheme, {
			syntaxTheme,
		});

		expect(lines[1]).toContain("\x1b[38;5;141mconst\x1b[39m");
		expect(lines[1]).toContain("\x1b[38;5;81musize\x1b[39m");
	});

	test("recognizes Zig source and package-manifest paths", () => {
		expect(getSyntaxLanguageFromPath("src/main.zig")).toBe("zig");
		expect(getSyntaxLanguageFromPath("build.zig.zon")).toBe("zig");
		expect(getSyntaxLanguageFromPath("src/main.rs")).toBe("rust");
	});

	test("highlights Zig syntax inside better-native-pi diffs", () => {
		const diffTheme = {
			...syntaxTheme,
			fg: (color: SyntaxColor | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string) =>
				color in ANSI_BY_COLOR
					? syntaxTheme.fg(color as SyntaxColor, text)
					: text,
		};

		const lines = colorizeDiff("+1 const value: usize = 1;", "src/main.zig", diffTheme);

		expect(lines[0]).toContain("\x1b[38;5;141mconst\x1b[39m");
		expect(lines[0]).toContain("\x1b[38;5;81musize\x1b[39m");
	});
});
