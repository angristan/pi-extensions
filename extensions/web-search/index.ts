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
	formatDisplayDate,
	formatOpenUrlResult,
	normalizeHttpUrl,
	parseSearchResultText,
	sanitizeSearchText,
} from "./client";
import { openUrl, searchNews, searchWeb, webStatus } from "./router";
import type { OpenDisplayDetails, ProviderAttempt, SearchDisplayDetails, SearchDisplayItem, WebProvider } from "./types";

const providerPreferenceSchema = Type.Optional(Type.String({
	description: "Optional provider to try first: 'exa', 'firecrawl', or 'mistral'. Leave unset unless a provider-specific retry is needed; unavailable providers are skipped and fallback continues.",
}));

const webSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Keyword web-search query. Include concrete dates for relative terms like latest, today, or this week.",
	}),
	startDate: Type.Optional(Type.String({ description: "Optional lower date bound in YYYY-MM-DD format." })),
	endDate: Type.Optional(Type.String({ description: "Optional upper date bound in YYYY-MM-DD format." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10, description: "Number of search results to return. Defaults to 10." })),
	provider: providerPreferenceSchema,
});

const newsSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Keyword news-search query. Use specific names, dates, and terms.",
	}),
	startDate: Type.Optional(Type.String({ description: "Optional lower date bound in YYYY-MM-DD format. Defaults server-side if omitted." })),
	endDate: Type.Optional(Type.String({ description: "Optional upper date bound in YYYY-MM-DD format. Defaults server-side if omitted." })),
	lang: Type.Optional(Type.String({ description: "Optional language filter, for example 'en' or 'fr'." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10, description: "Number of news results to return. Defaults to 10." })),
	provider: providerPreferenceSchema,
});

const openUrlSchema = Type.Object({
	url: Type.String({
		minLength: 1,
		description: "URL or news article ID returned by web_search or news_search.",
	}),
	provider: providerPreferenceSchema,
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

type OpenDetails = OpenDisplayDetails;

function compactQuery(query: unknown): string {
	return typeof query === "string" && query.trim() ? truncateToWidth(sanitizeSearchText(query, 2_000), 96, "…") : "";
}

function compactFilter(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? sanitizeSearchText(value, 200) : undefined;
}

function providerPreference(value: unknown): string | undefined {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (normalized === "exa") return "try Exa first";
	if (normalized === "firecrawl") return "try Firecrawl first";
	if (normalized === "mistral") return "try Mistral first";
	return undefined;
}

function searchDetail(args: (WebSearchArgs | NewsSearchArgs) | undefined, theme: Theme, details?: SearchDisplayDetails): string {
	const query = compactQuery(args?.query ?? details?.query);
	const dates = [compactFilter(args?.startDate ?? details?.startDate), compactFilter(args?.endDate ?? details?.endDate)].filter(Boolean).join(" → ");
	const lang = compactFilter(args && "lang" in args ? args.lang : details?.lang);
	const provider = providerPreference(args?.provider);
	const quotedQuery = query ? `${theme.fg("dim", "“")}${theme.fg("accent", query)}${theme.fg("dim", "”")}` : undefined;
	return [quotedQuery, dates || undefined, lang ? `lang ${lang}` : undefined, provider].filter(Boolean).join(" · ");
}

function compactError(text: string, fallback: string): string {
	const normalized = sanitizeSearchText(text, 2_000);
	return truncateToWidth(normalized || fallback, 160, "…");
}

function resultUrl(result: SearchDisplayItem): string | undefined {
	return normalizeHttpUrl(result.url);
}

function sourceUrl(result: SearchDisplayItem): string {
	const url = resultUrl(result);
	if (url) return url;
	return sanitizeSearchText(result.url ?? "", 2_048) || "URL unavailable";
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
	private source: (width: number) => string[];
	constructor(source: (width: number) => string[] = () => []) {
		this.source = source;
	}
	update(source: (width: number) => string[]): void {
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
		const lines = this.source(max).flatMap((line) =>
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
function providerLabel(provider: WebProvider): string {
	return provider === "exa" ? "Exa" : provider === "firecrawl" ? "Firecrawl" : "Mistral";
}

function routeLabel(provider: WebProvider | undefined, attempts: ProviderAttempt[] | undefined, searchEngine?: string): string | undefined {
	const trail = attempts?.filter((attempt) => attempt.status !== "skipped").map((attempt) => providerLabel(attempt.provider));
	const route = trail?.length ? trail.join(" → ") : provider ? providerLabel(provider) : undefined;
	if (!searchEngine || searchEngine.toLowerCase() === provider?.toLowerCase()) return route ?? searchEngine;
	return route ? `${route}/${searchEngine}` : searchEngine;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1_000) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1_000;
	let unitIndex = 0;
	while (value >= 1_000 && unitIndex < units.length - 1) {
		value /= 1_000;
		unitIndex += 1;
	}
	const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
	return `${rounded.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")} ${units[unitIndex]}`;
}

function searchSummary(details: SearchDisplayDetails, searchEngine: string | undefined, theme: Theme): string {
	const count = details.resultCount === 0 ? "No results" : `${details.resultCount} ${details.resultCount === 1 ? "result" : "results"}`;
	const elapsed = typeof details.elapsedMs === "number" ? formatElapsed(details.elapsedMs) : "done";
	const route = routeLabel(details.provider, details.attempts, searchEngine);
	const credits = details.creditsUsed ? `${details.creditsUsed} credit${details.creditsUsed === 1 ? "" : "s"}` : undefined;
	return [
		`${GREEN}${count}${RESET}`,
		route ? theme.fg("muted", `via ${route}`) : undefined,
		credits ? theme.fg("muted", credits) : undefined,
		elapsed,
	].filter(Boolean).join(theme.fg("dim", " · "));
}

function openSummary(details: OpenDetails | undefined): string {
	const lines = typeof details?.originalLines === "number" ? `${details.originalLines} line${details.originalLines === 1 ? "" : "s"}` : undefined;
	const bytes = typeof details?.originalBytes === "number" ? formatBytes(details.originalBytes) : undefined;
	const note = details?.truncated ? "truncated" : undefined;
	const route = routeLabel(details?.provider, details?.attempts);
	const credits = details?.creditsUsed ? `${details.creditsUsed} credit${details.creditsUsed === 1 ? "" : "s"}` : undefined;
	const parts = [lines, bytes, note].filter(Boolean);
	const detail = parts.length ? `${GREEN}${parts.join(" · ")}${RESET}` : `${GREEN}opened${RESET}`;
	const elapsed = typeof details?.elapsedMs === "number" ? formatElapsed(details.elapsedMs) : "done";
	return [detail, route ? `via ${route}` : undefined, credits, elapsed].filter(Boolean).join(" · ");
}

function renderSearchCall(args: WebSearchArgs | NewsSearchArgs, theme: Theme, context: ToolRenderContext) {
	// The call slot owns the running row. Once settled, hand off to the result
	// slot (return an empty container) so the verb isn't shown twice.
	if (!context.isPartial) return new Container();
	const component = reuseOrCreate(context);
	const detail = searchDetail(args, theme);
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
		const detail = searchDetail(args, theme);
		component.update(() => [
			headlineRow(false, true, "Search failed", detail),
			`${BRANCH}${theme.fg("error", compactError(storedText, "Unknown search error"))}`,
		]);
		return component;
	}

	const details = result?.details ?? parseSearchResultText(storedText);
	const results = details.results;
	const detail = searchDetail(args, theme, details);
	const searchEngine = sharedSearchEngine(details);
	const max = expanded ? 10 : 5;
	component.update(() => {
		const lines = [headlineRow(false, false, "Searched", detail), `${BRANCH}${searchSummary(details, searchEngine, theme)}`];
		const shownResults = results.slice(0, max);
		for (const [index, item] of shownResults.entries()) {
			const url = resultUrl(item);
			const label = sourceUrl(item);
			const rendered = url ? hyperlink(theme.fg("text", label), url) : theme.fg("muted", label);
			const website = resultWebsite(item);
			const itemSearchEngine = resultSearchEngine(item);
			const itemDate = formatDisplayDate(item.date);
			const via = !searchEngine && itemSearchEngine && itemSearchEngine.toLowerCase() !== website?.toLowerCase() ? `via ${itemSearchEngine}` : undefined;
			const meta = [
				via ? theme.fg("muted", via) : undefined,
				itemDate ? theme.fg("muted", itemDate) : undefined,
			].filter(Boolean).join(theme.fg("dim", " · "));
			lines.push(`${INDENT}${theme.fg("syntaxNumber", `${index + 1}.`)} ${rendered}${meta ? ` ${theme.fg("dim", "·")} ${meta}` : ""}`);
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
	const target = truncateToWidth(sanitizeSearchText(args.url, 2_048), 110, "…");
	const detail = [target, providerPreference(args.provider)].filter(Boolean).join(" · ");
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
			"Search the web through a quality-routed provider chain. Returns bounded structured results with URLs, titles, unique snippets, ranks, websites, provider attempts, and source metadata; it does not generate a final answer.",
		promptSnippet: "Search the web through quality-routed providers and return structured results",
		promptGuidelines: [
			"Use web_search for current or potentially changed external information—not local code—and prefer official or primary sources.",
			"Treat web_search and news_search as evidence retrieval: inspect important sources and cite the URLs used.",
		],
		parameters: webSearchSchema,
		renderShell: "self",
		async execute(_toolCallId, params: WebSearchArgs, signal) {
			return createSearchToolResult(await searchWeb(params, { signal }));
		},
		renderCall: (args: WebSearchArgs, theme: Theme, context: ToolRenderContext) => renderSearchCall(args, theme, context),
		renderResult: renderSearchResult,
	});

	pi.registerTool({
		name: "news_search",
		label: "News Search",
		description:
			"Search recent news through relevance-first providers. Returns bounded structured results with snippets, dates, URLs, ranks, provider attempts, and source metadata. Date and language constraints are best-effort when a provider lacks native filters.",
		promptSnippet: "Search recent news through relevance-first providers and return structured results",
		promptGuidelines: [
			"Use news_search for recent events, journalism, or date-bounded news.",
		],
		parameters: newsSearchSchema,
		renderShell: "self",
		async execute(_toolCallId, params: NewsSearchArgs, signal) {
			return createSearchToolResult(await searchNews(params, { signal }));
		},
		renderCall: (args: NewsSearchArgs, theme: Theme, context: ToolRenderContext) => renderSearchCall(args, theme, context),
		renderResult: renderSearchResult,
	});

	pi.registerTool({
		name: "open_url",
		label: "Open URL",
		description:
			"Fallback for opening an HTTP(S) URL through Exa, Firecrawl, or Mistral after local content retrieval fails. Mistral article IDs remain supported when configured.",
		promptSnippet: "Fallback opener for a URL when local content retrieval with tools like `ax` fails",
		promptGuidelines: [
			"Use open_url only when local content retrieval such as ax is unavailable, blocked, or fails.",
			"Use curl for protocol-level HTTP diagnostics; use ax or open_url for readable page content.",
		],
		parameters: openUrlSchema,
		renderShell: "self",
		async execute(_toolCallId, params: OpenUrlArgs, signal) {
			const result = await openUrl(params.url, { signal }, params.provider);
			return {
				content: [{ type: "text", text: formatOpenUrlResult(result) }],
				details: result,
			};
		},
		renderCall: renderOpenCall,
		renderResult: renderOpenResult,
	});

	pi.registerCommand("web-status", {
		description: "Show web search provider routing and availability",
		handler: (_args, ctx) => {
			const status = webStatus();
			const access = Object.entries(status.providers).map(([name, provider]) => `${name}: ${provider.available ? provider.keyed ? "keyed" : "anonymous" : "unavailable"}`).join(" · ");
			const routes = [
				`web: ${status.routes.web.join(" → ") || "none"}`,
				`news: ${status.routes.news.join(" → ") || "none"}`,
				`open: ${status.routes.open.join(" → ") || "none"}`,
			];
			const circuits = status.circuits.length ? `\nrate limited: ${status.circuits.map((item) => item.key).join(", ")}` : "";
			ctx.ui.notify(`${routes.join("\n")}\n${access}${circuits}`, "info");
		},
	});
}
