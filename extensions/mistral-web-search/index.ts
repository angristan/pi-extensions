import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, hyperlink, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
// Reuse better-native-pi's palette and helpers so the search rows are
// visually identical to the built-in tools' tidy rendering (same bullets,
// colors, tree prefixes, and elapsed formatting).
import { fitToolLine, formatElapsed } from "../better-native-pi/core.js";
import { BOLD, GREEN, MAGENTA, RED, RESET } from "../better-native-pi/render.js";
import {
	createSearchToolResult,
	detectOpenUrlFailure,
	formatOpenUrlResult,
	normalizeHttpUrl,
	openMistralUrl,
	parseSearchResultText,
	sanitizeSearchText,
	searchMistralNews,
	searchMistralWeb,
	type SearchDisplayDetails,
	type SearchDisplayItem,
} from "./client";

const FOUNDRY_OPENAI_PROVIDER = "foundry-openai";
const TOOL_NAMES = ["web_search", "news_search", "open_url"] as const;

const webSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Keyword web-search query. Include concrete dates for relative terms like latest, today, or this week.",
	}),
	startDate: Type.Optional(Type.String({ description: "Optional lower date bound in YYYY-MM-DD format." })),
	endDate: Type.Optional(Type.String({ description: "Optional upper date bound in YYYY-MM-DD format." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 20, description: "Number of search results to return. Defaults to 20." })),
});

const newsSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Keyword news-search query. Use specific names, dates, and terms.",
	}),
	startDate: Type.Optional(Type.String({ description: "Optional lower date bound in YYYY-MM-DD format. Defaults server-side if omitted." })),
	endDate: Type.Optional(Type.String({ description: "Optional upper date bound in YYYY-MM-DD format. Defaults server-side if omitted." })),
	lang: Type.Optional(Type.String({ description: "Optional language filter, for example 'en' or 'fr'." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 400, description: "Number of news results to return." })),
});

const openUrlSchema = Type.Object({
	url: Type.String({
		minLength: 1,
		description: "URL or news article ID returned by web_search or news_search.",
	}),
});

type WebSearchArgs = Static<typeof webSearchSchema>;
type NewsSearchArgs = Static<typeof newsSearchSchema>;
type OpenUrlArgs = Static<typeof openUrlSchema>;

type Theme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

// Minimal structural type for the render context passed to renderCall/renderResult.
// We only need lastComponent reuse and toolCallId/args/isPartial (ToolRenderContext
// is not re-exported by the public package, so we model just the fields we use).
interface ToolRenderContext {
	lastComponent: unknown;
	toolCallId?: string;
	args?: unknown;
	isPartial?: boolean;
	isError?: boolean;
}

interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

// Tree prefixes matching better-native-pi's transcript hierarchy exactly.
const LEAD = "";
const BRANCH = `${LEAD}  └ `;
const INDENT = `${LEAD}    `;

type OpenDetails = {
	url?: string;
	elapsedMs?: number;
	truncated?: boolean;
	originalBytes?: number;
	originalLines?: number;
	content?: string;
};

function isFoundryOpenAIModel(model: { provider?: string } | undefined): boolean {
	return model?.provider === FOUNDRY_OPENAI_PROVIDER;
}

function syncToolAvailability(pi: ExtensionAPI, model: { provider?: string } | undefined): void {
	const active = new Set(pi.getActiveTools());
	const before = active.size;

	if (isFoundryOpenAIModel(model)) {
		for (const name of TOOL_NAMES) active.delete(name);
	} else {
		for (const name of TOOL_NAMES) active.add(name);
	}

	if (active.size !== before || TOOL_NAMES.some((name) => pi.getActiveTools().includes(name) !== active.has(name))) {
		pi.setActiveTools([...active]);
	}
}

function compactQuery(query: unknown): string {
	return typeof query === "string" && query.trim() ? truncateToWidth(sanitizeSearchText(query, 2_000), 96, "…") : "";
}

function compactFilter(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? sanitizeSearchText(value, 200) : undefined;
}

function searchDetail(args: (WebSearchArgs | NewsSearchArgs) | undefined, details?: SearchDisplayDetails): string {
	const query = compactQuery(args?.query ?? details?.query);
	const dates = [compactFilter(args?.startDate ?? details?.startDate), compactFilter(args?.endDate ?? details?.endDate)].filter(Boolean).join(" → ");
	const lang = compactFilter(args && "lang" in args ? args.lang : details?.lang);
	return [query ? `“${query}”` : undefined, dates || undefined, lang ? `lang ${lang}` : undefined].filter(Boolean).join(" · ");
}

function compactError(text: string, fallback: string): string {
	const normalized = sanitizeSearchText(text, 2_000);
	return truncateToWidth(normalized || fallback, 160, "…");
}

function sourceLabel(result: SearchDisplayItem): string {
	const label = result.title || result.url || "untitled";
	return truncateToWidth(sanitizeSearchText(label, 600), 110, "…");
}

function resultUrl(result: SearchDisplayItem): string | undefined {
	return normalizeHttpUrl(result.url);
}

function resultWebsite(result: SearchDisplayItem): string | undefined {
	if (result.website) return sanitizeSearchText(result.website, 200);
	const url = resultUrl(result);
	return url ? new URL(url).hostname.replace(/^www\./i, "") || undefined : undefined;
}

function resultSearchEngine(result: SearchDisplayItem): string | undefined {
	const value = result.searchEngine ?? result.source;
	if (!value) return undefined;
	const safe = sanitizeSearchText(value, 200);
	return safe ? `${safe.charAt(0).toUpperCase()}${safe.slice(1)}` : undefined;
}

function sharedSearchEngine(details: SearchDisplayDetails): string | undefined {
	if (details.searchEngine) return resultSearchEngine({ searchEngine: details.searchEngine, snippets: [] });
	const engines = new Set(details.results.map(resultSearchEngine).filter((value): value is string => Boolean(value)));
	return engines.size === 1 ? [...engines][0] : undefined;
}

// A tiny width-aware component mirroring better-native-pi's WidthAwareLines so the
// Rows reflow to the terminal width exactly like the built-in
// tools. The source is re-evaluated each render so partial->settled updates
// are reflected without leaking stale ANSI.
class SearchLines implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private source: () => string[];
	constructor(source: () => string[] = () => []) {
		this.source = source;
	}
	update(source: () => string[]): void {
		this.source = source;
		this.invalidate();
	}
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
	render(width: number): string[] {
		const max = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === max) return this.cachedLines;
		const lines = this.source().flatMap((line) =>
			visibleWidth(line) <= max ? [line] : [fitToolLine(line, max)],
		);
		this.cachedLines = lines;
		this.cachedWidth = max;
		return lines;
	}
}

function reuseOrCreate(context: ToolRenderContext): SearchLines {
	const existing = context.lastComponent;
	return existing instanceof SearchLines ? existing : new SearchLines();
}

// Headline row shared by the three tools:
//   {LEAD}{• magenta|green|red} {BOLD}{verb}{RESET} {detail}
// `verb` is present/progressive while partial ("Searching"), past once done.
function headlineRow(partial: boolean, isError: boolean, verb: string, detail: string): string {
	const mark = partial ? `${MAGENTA}•${RESET}` : isError ? `${RED}•${RESET}` : `${GREEN}•${RESET}`;
	return `${LEAD}${mark} ${BOLD}${verb}${RESET}${detail ? ` ${detail}` : ""}`;
}

// Colored summary that follows the `└ ` branch, matching tidy tools' shape:
// `<count> <noun> · <elapsed>` (and a truncation note when content was clipped).
function searchSummary(resultCount: number, elapsedMs: number | undefined, searchEngine: string | undefined, theme: Theme): string {
	const count = resultCount === 0 ? "No results" : `${resultCount} ${resultCount === 1 ? "result" : "results"}`;
	const elapsed = typeof elapsedMs === "number" ? formatElapsed(elapsedMs) : "done";
	return [
		`${GREEN}${count}${RESET}`,
		searchEngine ? theme.fg("muted", `via ${searchEngine}`) : undefined,
		elapsed,
	].filter(Boolean).join(theme.fg("dim", " · "));
}

function openSummary(details: OpenDetails | undefined): string {
	const lines = typeof details?.originalLines === "number" ? `${details.originalLines} line${details.originalLines === 1 ? "" : "s"}` : undefined;
	const bytes = typeof details?.originalBytes === "number" ? `${details.originalBytes}b` : undefined;
	const note = details?.truncated ? "truncated" : undefined;
	const parts = [lines, bytes, note].filter(Boolean);
	const detail = parts.length ? `${GREEN}${parts.join(" · ")}${RESET}` : `${GREEN}opened${RESET}`;
	const elapsed = typeof details?.elapsedMs === "number" ? formatElapsed(details.elapsedMs) : "done";
	return `${detail} · ${elapsed}`;
}

function renderSearchCall(args: WebSearchArgs | NewsSearchArgs, _theme: Theme, context: ToolRenderContext) {
	// The call slot owns the running row. Once settled, hand off to the result
	// slot (return an empty container) so the verb isn't shown twice.
	if (!context.isPartial) return new Container();
	const component = reuseOrCreate(context);
	const detail = searchDetail(args);
	component.update(() => [headlineRow(true, false, "Searching", detail)]);
	return component;
}

function renderSearchResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: SearchDisplayDetails } | undefined,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
) {
	// The result slot stays empty while streaming so the running call slot
	// owns the row; it replaces it once settled to avoid duplicating the verb.
	if (isPartial) return new Container();
	const component = reuseOrCreate(context);
	const storedText = result?.content
		?.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n") ?? "";
	const args = context.args as WebSearchArgs | NewsSearchArgs | undefined;

	if (context.isError) {
		const detail = searchDetail(args);
		component.update(() => [
			headlineRow(false, true, "Search failed", detail),
			`${BRANCH}${theme.fg("error", compactError(storedText, "Unknown search error"))}`,
		]);
		return component;
	}

	const details = result?.details ?? parseSearchResultText(storedText);
	const results = details.results;
	const detail = searchDetail(args, details);
	const searchEngine = sharedSearchEngine(details);
	const max = expanded ? 10 : 5;
	component.update(() => {
		const lines = [headlineRow(false, false, "Searched", detail), `${BRANCH}${searchSummary(details.resultCount, details.elapsedMs, searchEngine, theme)}`];
		const shownResults = results.slice(0, max);
		for (const [index, item] of shownResults.entries()) {
			const label = sourceLabel(item);
			const url = resultUrl(item);
			const rendered = url ? hyperlink(theme.fg("mdLink", label), url) : theme.fg("toolOutput", label);
			const website = resultWebsite(item);
			const itemSearchEngine = resultSearchEngine(item);
			const via = !searchEngine && itemSearchEngine && itemSearchEngine.toLowerCase() !== website?.toLowerCase() ? `via ${itemSearchEngine}` : undefined;
			const meta = [
				website ? theme.fg("accent", website) : undefined,
				via ? theme.fg("muted", via) : undefined,
				item.date ? theme.fg("syntaxNumber", item.date) : undefined,
			].filter(Boolean).join(theme.fg("dim", " · "));
			lines.push(`${INDENT}${theme.fg("syntaxNumber", `${index + 1}.`)} ${rendered}${meta ? ` ${theme.fg("dim", "—")} ${meta}` : ""}`);
			const evidence = item.snippets?.[0] ?? item.description;
			if (evidence) {
				lines.push(`${INDENT}   ${theme.fg("dim", truncateToWidth(evidence.replace(/\s+/g, " ").trim(), 140, "…"))}`);
			}
		}
		const shown = shownResults.length;
		const remaining = Math.max(0, details.resultCount - shown);
		if (remaining > 0) {
			lines.push(`${INDENT}${theme.fg("syntaxNumber", String(shown))}${theme.fg("muted", " shown · ")}${theme.fg("syntaxNumber", String(remaining))}${theme.fg("muted", " more")}`);
		}
		return lines;
	});
	return component;
}

function renderOpenTarget(value: string, theme: Theme): string {
	const safe = truncateToWidth(sanitizeSearchText(value, 2_048), 110, "…");
	const url = normalizeHttpUrl(value);
	return url ? hyperlink(theme.fg("mdLink", safe), url) : theme.fg("toolOutput", safe);
}

function renderOpenCall(args: OpenUrlArgs, _theme: Theme, context: ToolRenderContext) {
	if (!context.isPartial) return new Container();
	const component = reuseOrCreate(context);
	const detail = truncateToWidth(sanitizeSearchText(args.url, 2_048), 110, "…");
	component.update(() => [headlineRow(true, false, "Opening", detail)]);
	return component;
}

function renderOpenResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: OpenDetails } | undefined,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
) {
	if (isPartial) return new Container();
	const component = reuseOrCreate(context);
	const details = result?.details;
	const args = context.args as OpenUrlArgs | undefined;
	const target = details?.url ?? args?.url ?? "";
	const storedText = result?.content
		?.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n") ?? "";

	if (context.isError) {
		const failure = detectOpenUrlFailure(storedText);
		const blocked = failure?.kind === "blocked";
		const reason = failure?.message ?? compactError(storedText, "Unknown open error");
		component.update(() => [
			headlineRow(false, true, blocked ? "Open blocked" : "Open failed", target ? renderOpenTarget(target, theme) : ""),
			`${BRANCH}${theme.fg("error", compactError(reason, "Unknown open error"))}`,
		]);
		return component;
	}

	component.update(() => {
		const lines = [
			headlineRow(false, false, "Opened", target ? renderOpenTarget(target, theme) : ""),
			`${BRANCH}${openSummary(details)}`,
		];
		if (expanded && details?.content) {
			lines.push("");
			for (const line of details.content.split("\n").slice(0, 12)) {
				lines.push(`${INDENT}${theme.fg("dim", truncateToWidth(sanitizeSearchText(line, 2_000), 160, "…"))}`);
			}
		}
		return lines;
	});
	return component;
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Mistral's direct web_search MCP connector. Returns raw search results with URLs, titles, descriptions, snippets, ranks, and source metadata; it does not generate a final answer.",
		promptSnippet: "Search the web through Mistral's direct MCP connector and return raw results",
		promptGuidelines: [
			"Use web_search to discover current or potentially changed web information; it returns raw results, not a final answer.",
			"Prefer official or primary-source results from web_search. Inspect important pages with local content tools like `ax`; use open_url only when local retrieval is unavailable or fails.",
			"Do not use web_search for local codebase search; use grep/read/ls/find for local files.",
		],
		parameters: webSearchSchema,
		renderShell: "self",
		async execute(_toolCallId, params: WebSearchArgs, signal) {
			return createSearchToolResult(await searchMistralWeb(params, { signal }));
		},
		renderCall: (args: WebSearchArgs, theme: Theme, context: ToolRenderContext) => renderSearchCall(args, theme, context),
		renderResult: renderSearchResult,
	});

	pi.registerTool({
		name: "news_search",
		label: "News Search",
		description:
			"Search news articles using Mistral's direct news_search MCP connector. Returns raw news results with snippets, dates, URLs or article IDs, ranks, and source metadata.",
		promptSnippet: "Search recent news through Mistral's direct MCP connector and return raw results",
		promptGuidelines: [
			"Use news_search for recent events, journalism, or date-bounded news queries; it returns raw news results, not a final answer.",
			"When news_search returns a URL or article ID that matters, inspect it with local content tools like `ax`; use open_url only when local retrieval is unavailable or fails.",
		],
		parameters: newsSearchSchema,
		renderShell: "self",
		async execute(_toolCallId, params: NewsSearchArgs, signal) {
			return createSearchToolResult(await searchMistralNews(params, { signal }));
		},
		renderCall: (args: NewsSearchArgs, theme: Theme, context: ToolRenderContext) => renderSearchCall(args, theme, context),
		renderResult: renderSearchResult,
	});

	pi.registerTool({
		name: "open_url",
		label: "Open URL",
		description:
			"Fallback for opening a URL or news article ID through Mistral's direct open_url MCP connector when local content retrieval with tools like `ax` is unavailable or fails. Returns readable page text.",
		promptSnippet: "Fallback opener for a URL or news article ID when local content retrieval with tools like `ax` fails",
		promptGuidelines: [
			"Use open_url only as a fallback when local content retrieval with tools like `ax` is unavailable, blocked, or fails.",
			"Cite URLs from open_url or search results when making claims based on web content.",
		],
		parameters: openUrlSchema,
		renderShell: "self",
		async execute(_toolCallId, params: OpenUrlArgs, signal) {
			const result = await openMistralUrl(params.url, { signal });
			return {
				content: [{ type: "text", text: formatOpenUrlResult(result) }],
				details: result,
			};
		},
		renderCall: renderOpenCall,
		renderResult: renderOpenResult,
	});

	pi.on("session_start", (_event, ctx) => syncToolAvailability(pi, ctx.model));
	pi.on("model_select", (event) => syncToolAvailability(pi, event.model));
}
