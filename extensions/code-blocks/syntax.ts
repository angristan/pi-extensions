import { createHighlighterCoreSync, type ThemedToken } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import zig from "@shikijs/langs/zig";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

export type SyntaxColor =
	| "mdCodeBlock"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation";

export interface SyntaxTheme {
	fg(color: SyntaxColor, text: string): string;
}

const TOKEN_COLORS = {
	mdCodeBlock: "#010101",
	syntaxComment: "#010102",
	syntaxKeyword: "#010103",
	syntaxFunction: "#010104",
	syntaxVariable: "#010105",
	syntaxString: "#010106",
	syntaxType: "#010107",
	syntaxOperator: "#010108",
	syntaxNumber: "#010109",
	syntaxPunctuation: "#01010a",
} as const satisfies Record<SyntaxColor, string>;

const COLOR_TO_TOKEN = new Map<string, SyntaxColor>(
	Object.entries(TOKEN_COLORS).map(([token, color]) => [color, token as SyntaxColor]),
);

// Sentinel colors make Shiki perform TextMate scope matching without imposing a
// fixed editor palette. The renderer maps each sentinel back to the active Pi
// theme, so Zig follows theme changes like Pi's native language highlighter.
const semanticTheme = {
	name: "pi-semantic-zig",
	type: "dark" as const,
	colors: { "editor.foreground": TOKEN_COLORS.mdCodeBlock },
	settings: [
		{ settings: { foreground: TOKEN_COLORS.mdCodeBlock } },
		{ scope: ["comment"], settings: { foreground: TOKEN_COLORS.syntaxComment } },
		{ scope: ["keyword.operator"], settings: { foreground: TOKEN_COLORS.syntaxOperator } },
		{
			scope: ["keyword.type", "storage.type", "entity.name.type", "support.type"],
			settings: { foreground: TOKEN_COLORS.syntaxType },
		},
		{ scope: ["keyword", "storage"], settings: { foreground: TOKEN_COLORS.syntaxKeyword } },
		{
			scope: ["entity.name.function", "support.function"],
			settings: { foreground: TOKEN_COLORS.syntaxFunction },
		},
		{ scope: ["variable"], settings: { foreground: TOKEN_COLORS.syntaxVariable } },
		{
			scope: ["string", "constant.character"],
			settings: { foreground: TOKEN_COLORS.syntaxString },
		},
		{ scope: ["constant.numeric"], settings: { foreground: TOKEN_COLORS.syntaxNumber } },
		{ scope: ["punctuation"], settings: { foreground: TOKEN_COLORS.syntaxPunctuation } },
	],
};

// Only Zig and the JavaScript RegExp engine are loaded. Initialize on the first
// Zig block to avoid adding grammar compilation to normal Pi startup.
let zigHighlighter: ReturnType<typeof createHighlighterCoreSync> | undefined;

function getZigHighlighter(): ReturnType<typeof createHighlighterCoreSync> {
	zigHighlighter ??= createHighlighterCoreSync({
		themes: [semanticTheme],
		langs: [zig],
		engine: createJavaScriptRegexEngine(),
	});
	return zigHighlighter;
}

export function normalizeLanguage(language: unknown): string | undefined {
	if (typeof language !== "string") return undefined;
	const normalized = language.trim().split(/\s+/, 1)[0]?.toLowerCase();
	return normalized || undefined;
}

export function getSyntaxLanguageFromPath(filePath: string): string | undefined {
	const extension = filePath.split(".").pop()?.toLowerCase();
	if (extension === "zig" || extension === "zon") return "zig";
	return getLanguageFromPath(filePath);
}

function renderToken(token: ThemedToken, theme: SyntaxTheme): string {
	const color = token.color?.toLowerCase();
	const semanticColor = (color && COLOR_TO_TOKEN.get(color)) ?? "mdCodeBlock";
	return theme.fg(semanticColor, token.content);
}

export function highlightZigCode(code: string, theme: SyntaxTheme): string[] {
	const { tokens } = getZigHighlighter().codeToTokens(code, {
		lang: "zig",
		theme: semanticTheme.name,
	});
	return tokens.map((line) => line.map((token) => renderToken(token, theme)).join(""));
}

export function highlightCodeForLanguage(
	code: string,
	language: string | undefined,
	theme?: SyntaxTheme,
): string[] {
	if (normalizeLanguage(language) === "zig" && theme) return highlightZigCode(code, theme);
	return highlightCode(code, language);
}
