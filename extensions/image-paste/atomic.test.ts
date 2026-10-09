import { expect, test } from "bun:test";
import { Editor } from "@earendil-works/pi-tui";
import { highlightTokens, makeTokensAtomic, mergeTokenSegments, tokenSpans } from "./atomic.ts";

const identity = (text: string) => text;
const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
const BACKSPACE = "\x7f", DELETE = "\x1b[3~", LEFT = "\x1b[D", RIGHT = "\x1b[C", UNDO = "\x1f", CTRL_W = "\x17";

function editorWith(text: string, live: Set<number>) {
	const editor = new Editor(tui as never, theme);
	expect(makeTokensAtomic(editor, { isLive: (label) => live.has(label), highlight: (token) => `<${token}>` })).toBe(true);
	editor.handleInput(`\x1b[200~${text}\x1b[201~`);
	const state = () => ({ text: editor.getText(), col: editor.getCursor().col });
	return { editor, state, press: (...keys: string[]) => { for (const key of keys) editor.handleInput(key); return state(); } };
}

test("only live tokens become spans", () => {
	expect(tokenSpans("a [Image 1] b [Image 2] [image 3]", (label) => label === 2)).toEqual([{ start: 14, end: 23 }]);
});

test("word segments use a whitespace-free stand-in of the same length", () => {
	const text = "see [Image 1].";
	const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	const merged = mergeTokenSegments(text, segmenter.segment(text), tokenSpans(text, () => true), "word");
	expect(merged.map((segment) => segment.segment)).toEqual(["see", " ", "[Image_1]", "."]);
	expect(merged.map((segment) => segment.index)).toEqual([0, 3, 4, 13]);
});

test("one Backspace deletes a whole live token, and one undo restores it", () => {
	const { press } = editorWith("fix [Image 1] ", new Set([1]));
	expect(press(BACKSPACE)).toEqual({ text: "fix [Image 1]", col: 13 });
	expect(press(BACKSPACE)).toEqual({ text: "fix ", col: 4 });
	expect(press(UNDO)).toEqual({ text: "fix [Image 1]", col: 13 });
});

test("Delete, arrows and word deletion treat a live token as one unit", () => {
	const { press } = editorWith("fix [Image 1]", new Set([1]));
	expect(press(LEFT)).toEqual({ text: "fix [Image 1]", col: 4 });
	expect(press(RIGHT)).toEqual({ text: "fix [Image 1]", col: 13 });
	expect(press(CTRL_W)).toEqual({ text: "fix ", col: 4 });
	press(UNDO);
	expect(press(LEFT, DELETE)).toEqual({ text: "fix ", col: 4 });
});

test("live tokens render as one highlighted block; the cursor keeps its own style", () => {
	const live = new Set([1]);
	const { editor, press } = editorWith("see [Image 1] [Image 2] ", live);
	expect(editor.render(40).join("\n")).toContain("see <[Image 1]> [Image 2]");
	press(...Array(12).fill(LEFT));
	expect(editor.getCursor().col).toBe(4);
	expect(editor.render(40).join("\n")).toContain("\x1b[7m[Image 1]\x1b[0m");
	expect(highlightTokens(["[Image 1]"], { isLive: () => false, highlight: (token) => `<${token}>` })).toEqual(["[Image 1]"]);
});

test("tokens whose image is gone are plain text", () => {
	const live = new Set<number>();
	const { press } = editorWith("[Image 1]", live);
	expect(press(BACKSPACE)).toEqual({ text: "[Image 1", col: 8 });
	press(UNDO);
	live.add(1);
	expect(press(BACKSPACE)).toEqual({ text: "", col: 0 });
});

test("re-patching swaps the live-label check without wrapping twice", () => {
	const { editor, press } = editorWith("[Image 1]", new Set());
	makeTokensAtomic(editor, { isLive: (label) => label === 1 });
	expect(press(BACKSPACE)).toEqual({ text: "", col: 0 });
});

test("editors without segmentation are left alone", () => {
	expect(makeTokensAtomic({}, { isLive: () => true })).toBe(false);
});
