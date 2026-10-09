type Mode = "grapheme" | "word";
type Segmenter = (text: string, mode?: Mode) => Iterable<Intl.SegmentData>;
export type IsLive = (label: number) => boolean;

export interface TokenBehavior {
	isLive: IsLive;
	/** Style a live token as one block in the editor, like OpenCode's extmarks. */
	highlight?: (token: string) => string;
}

/** Global so a reloaded extension updates, rather than re-wraps, an editor it already patched. */
const BEHAVIOR = Symbol.for("pi-extensions.image-paste.token-behavior");

interface Patchable {
	segment?: Segmenter;
	render?: (width: number) => string[];
	[BEHAVIOR]?: TokenBehavior;
}

const TOKEN = /\[Image (\d+)\]/g;
/** A token in rendered editor output, optionally under the editor's inverse-video cursor. */
const RENDERED_TOKEN = /(\x1b\[7m)?\[Image (\d+)\]/g;

/** Highlight live tokens in rendered lines; one under the cursor keeps the cursor's style. */
export function highlightTokens(lines: string[], behavior: TokenBehavior): string[] {
	const { isLive, highlight } = behavior;
	if (!highlight) return lines;
	return lines.map((line) => line.includes("[Image ")
		? line.replace(RENDERED_TOKEN, (match, cursor: string | undefined, label: string) => cursor || !isLive(Number(label)) ? match : highlight(match))
		: line);
}

/** Character ranges of `[Image N]` tokens whose image is still attached. */
export function tokenSpans(text: string, isLive: IsLive): { start: number; end: number }[] {
	if (!text.includes("[Image ")) return [];
	return [...text.matchAll(TOKEN)]
		.filter((match) => isLive(Number(match[1])))
		.map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/**
 * Merge each token span into one segment. Word-mode tokens get a
 * whitespace-free stand-in of equal length, so word deletion and movement
 * treat them as one punctuation run instead of as whitespace.
 */
export function mergeTokenSegments(text: string, segments: Iterable<Intl.SegmentData>, spans: { start: number; end: number }[], mode: Mode = "grapheme"): Intl.SegmentData[] {
	const base = [...segments];
	const wordLike = new Map(base.map((segment) => [segment.index, segment.isWordLike]));
	const tokens = new Set(spans.map((span) => span.start));
	const cuts = new Set([...base.map((segment) => segment.index), text.length]);
	for (const span of spans) {
		for (const cut of cuts) if (cut > span.start && cut < span.end) cuts.delete(cut);
		cuts.add(span.start).add(span.end);
	}
	const bounds = [...cuts].sort((a, b) => a - b);
	const merged: Intl.SegmentData[] = [];
	for (let i = 0; i + 1 < bounds.length; i++) {
		const index = bounds[i]!;
		const raw = text.slice(index, bounds[i + 1]);
		if (tokens.has(index)) {
			merged.push(mode === "word" ? { segment: raw.replace(/\s/g, "_"), index, input: text, isWordLike: false } : { segment: raw, index, input: text });
		} else {
			merged.push(mode === "word" ? { segment: raw, index, input: text, isWordLike: wordLike.get(index) ?? false } : { segment: raw, index, input: text });
		}
	}
	return merged;
}

/**
 * Make live `[Image N]` tokens atomic in Pi's editor, as it does for its own
 * `[paste #N]` markers: one Backspace or Delete removes the whole token, the
 * cursor steps over it, one undo restores it, and it renders as one
 * highlighted block. Relies on the editor's internal `segment` method; returns
 * false when that is unavailable so tokens degrade to plain text.
 */
export function makeTokensAtomic(component: object, behavior: TokenBehavior): boolean {
	const editor = component as Patchable;
	if (typeof editor.segment !== "function" || typeof editor.render !== "function") return false;
	if (!(BEHAVIOR in editor)) {
		const segment = editor.segment.bind(editor);
		const render = editor.render.bind(editor);
		editor.segment = (text, mode) => {
			const spans = editor[BEHAVIOR] ? tokenSpans(text, editor[BEHAVIOR].isLive) : [];
			return spans.length ? mergeTokenSegments(text, segment(text, mode), spans, mode) : segment(text, mode);
		};
		editor.render = (width) => editor[BEHAVIOR] ? highlightTokens(render(width), editor[BEHAVIOR]) : render(width);
	}
	editor[BEHAVIOR] = behavior;
	return true;
}
