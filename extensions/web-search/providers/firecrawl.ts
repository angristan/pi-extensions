import { detectOpenUrlFailure, normalizeHttpUrl, truncateText } from "../client";
import { combineSignals, WebProviderError } from "../provider-error";
import type {
	NewsSearchArgs,
	NewsSearchResult,
	OpenUrlResult,
	ProviderOptions,
	RagResult,
	WebSearchArgs,
	WebSearchResult,
} from "../types";

const FIRECRAWL_API = "https://api.firecrawl.dev/v2";
const DEFAULT_TIMEOUT_MS = 30_000;

function headers(): Record<string, string> {
	const key = process.env.FIRECRAWL_API_KEY?.trim();
	return {
		"Content-Type": "application/json",
		...(key ? { Authorization: `Bearer ${key}` } : {}),
	};
}

async function post(path: string, body: Record<string, unknown>, options: ProviderOptions = {}): Promise<{ payload: any; elapsedMs: number }> {
	const started = performance.now();
	let response: Response;
	try {
		response = await fetch(`${FIRECRAWL_API}${path}`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
			signal: combineSignals(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		throw new WebProviderError(`Firecrawl request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const raw = await response.text();
	let payload: any;
	try {
		payload = raw ? JSON.parse(raw) : {};
	} catch (error) {
		throw new WebProviderError(`Firecrawl returned invalid JSON (HTTP ${response.status})`, { status: response.status, cause: error });
	}
	if (!response.ok || !payload?.success) {
		const message = typeof payload?.error === "string" ? payload.error : raw.slice(0, 300) || response.statusText;
		throw new WebProviderError(`Firecrawl HTTP ${response.status}: ${message}`, {
			status: response.status,
			retriable: response.status === 408 || response.status === 429 || response.status >= 500,
		});
	}
	return { payload, elapsedMs: performance.now() - started };
}

function boundedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(20, Math.trunc(limit ?? 10)));
}

export function parseFirecrawlItems(items: any[], source = "firecrawl"): RagResult[] {
	const seen = new Set<string>();
	const results: RagResult[] = [];
	for (const item of items) {
		const url = normalizeHttpUrl(item?.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const description = typeof item?.description === "string" ? item.description : typeof item?.snippet === "string" ? item.snippet : null;
		results.push({
			id: String(item?.id ?? url),
			url,
			title: typeof item?.title === "string" ? item.title : url,
			description,
			snippets: description ? [description] : [],
			date: typeof item?.date === "string" ? item.date : null,
			rank: results.length + 1,
			source,
			metadata: null,
			canOpen: true,
		});
	}
	return results;
}

function mmddyyyy(date: string): string | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	return match ? `${match[2]}/${match[3]}/${match[1]}` : undefined;
}

export function dateFilter(startDate?: string, endDate?: string): string | undefined {
	const start = startDate ? mmddyyyy(startDate) : undefined;
	const end = endDate ? mmddyyyy(endDate) : undefined;
	if (!start && !end) return undefined;
	return ["cdr:1", start ? `cd_min:${start}` : undefined, end ? `cd_max:${end}` : undefined].filter(Boolean).join(",");
}

export function newsDateFilter(startDate?: string, endDate?: string): string {
	return dateFilter(startDate, endDate) ?? "qdr:w";
}

function credits(payload: any): number | undefined {
	const value = payload?.creditsUsed ?? payload?.data?.metadata?.creditsUsed;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function searchFirecrawlWeb(args: WebSearchArgs, options: ProviderOptions = {}): Promise<WebSearchResult> {
	const query = args.query.trim();
	const limit = boundedLimit(args.limit);
	const tbs = dateFilter(args.startDate, args.endDate);
	const response = await post("/search", {
		query,
		limit,
		sources: ["web"],
		...(tbs ? { tbs } : {}),
	}, options);
	return {
		provider: "firecrawl",
		tool: "web_search",
		query,
		startDate: args.startDate,
		endDate: args.endDate,
		limit,
		results: parseFirecrawlItems(response.payload?.data?.web ?? []).slice(0, limit),
		elapsedMs: response.elapsedMs,
		creditsUsed: credits(response.payload),
	};
}

export async function searchFirecrawlNews(args: NewsSearchArgs, options: ProviderOptions = {}): Promise<NewsSearchResult> {
	const query = args.query.trim();
	const limit = boundedLimit(args.limit);
	const response = await post("/search", {
		query,
		limit,
		sources: ["news"],
		tbs: newsDateFilter(args.startDate, args.endDate),
	}, options);
	return {
		provider: "firecrawl",
		tool: "news_search",
		query,
		startDate: args.startDate,
		endDate: args.endDate,
		lang: args.lang?.trim() || undefined,
		limit,
		results: parseFirecrawlItems(response.payload?.data?.news ?? []).slice(0, limit),
		elapsedMs: response.elapsedMs,
		creditsUsed: credits(response.payload),
	};
}

export async function openFirecrawlUrl(url: string, options: ProviderOptions = {}): Promise<OpenUrlResult> {
	const target = normalizeHttpUrl(url);
	if (!target) throw new WebProviderError("Firecrawl can only open HTTP(S) URLs", { retriable: false });
	const timeoutMs = options.timeoutMs ?? 60_000;
	const response = await post("/scrape", {
		url: target,
		formats: ["markdown"],
		onlyMainContent: true,
		timeout: timeoutMs,
	}, { ...options, timeoutMs });
	const content = typeof response.payload?.data?.markdown === "string" ? response.payload.data.markdown : "";
	if (!content.trim()) throw new WebProviderError("Firecrawl returned empty page content");
	const failure = detectOpenUrlFailure(content);
	if (failure) throw new WebProviderError(failure.message, { blocked: failure.kind === "blocked" });
	const truncated = truncateText(content);
	return {
		provider: "firecrawl",
		tool: "open_url",
		url: target,
		elapsedMs: response.elapsedMs,
		creditsUsed: credits(response.payload),
		...truncated,
	};
}
