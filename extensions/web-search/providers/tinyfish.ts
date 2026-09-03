import {
	detectOpenUrlFailure,
	normalizeHttpUrl,
	truncateText,
} from "../client";
import { combineSignals, WebProviderError } from "../provider-error";
import type {
	OpenUrlResult,
	ProviderOptions,
	RagResult,
	WebSearchArgs,
	WebSearchResult,
} from "../types";

const TINYFISH_SEARCH_API = "https://api.search.tinyfish.ai";
const TINYFISH_FETCH_API = "https://api.fetch.tinyfish.ai";
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const SEARCH_PAGE_SIZE = 10;

export function hasTinyFishAccess(): boolean {
	return Boolean(process.env.TINYFISH_API_KEY?.trim());
}

function apiKey(): string {
	const key = process.env.TINYFISH_API_KEY?.trim();
	if (!key) throw new WebProviderError("TINYFISH_API_KEY is not set.", { retriable: true });
	return key;
}

function errorDetail(payload: unknown, raw: string): string {
	if (payload && typeof payload === "object") {
		const error = (payload as { error?: unknown }).error;
		if (typeof error === "string" && error.trim()) return error.trim();
		if (error && typeof error === "object") {
			const message = (error as { message?: unknown }).message;
			if (typeof message === "string" && message.trim()) return message.trim();
		}
	}
	return raw.trim().slice(0, 300) || "Unknown error";
}

async function requestJson(
	service: "search" | "fetch",
	url: string,
	init: RequestInit,
	options: ProviderOptions,
	defaultTimeoutMs: number,
): Promise<unknown> {
	let response: Response;
	try {
		const headers = new Headers(init.headers);
		headers.set("Accept", "application/json");
		headers.set("X-API-Key", apiKey());
		response = await fetch(url, {
			...init,
			headers,
			signal: combineSignals(options.signal, options.timeoutMs ?? defaultTimeoutMs),
		});
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		throw new WebProviderError(`TinyFish ${service} request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}

	const raw = await response.text();
	let payload: unknown;
	try {
		payload = raw ? JSON.parse(raw) : {};
	} catch (error) {
		throw new WebProviderError(`TinyFish ${service} returned invalid JSON (HTTP ${response.status})`, { status: response.status, cause: error });
	}
	if (!response.ok) {
		throw new WebProviderError(`TinyFish ${service} HTTP ${response.status}: ${errorDetail(payload, raw)}`, {
			status: response.status,
			retriable: response.status !== 400 && response.status !== 422,
		});
	}
	return payload;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanedDomains(values: string[] | undefined): string[] | undefined {
	const domains = values?.map((value) => value.trim()).filter(Boolean);
	return domains?.length ? domains : undefined;
}

function yearFromDate(value: string | undefined): number | undefined {
	const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value ?? "");
	return match ? Number(match[1]) : undefined;
}

function searchUrl(args: WebSearchArgs, page: number): string {
	const url = new URL(TINYFISH_SEARCH_API);
	url.searchParams.set("query", args.query.trim());
	url.searchParams.set("page", String(page));
	const includeDomains = cleanedDomains(args.includeDomains);
	const excludeDomains = cleanedDomains(args.excludeDomains);
	if (includeDomains) url.searchParams.set("include_domains", includeDomains.join(","));
	if (excludeDomains) url.searchParams.set("exclude_domains", excludeDomains.join(","));

	if (args.category === "publication") {
		url.searchParams.set("domain_type", "research_paper");
		const minimumYear = yearFromDate(args.startDate);
		const maximumYear = yearFromDate(args.endDate);
		if (minimumYear !== undefined) url.searchParams.set("pub_year_min", String(minimumYear));
		if (maximumYear !== undefined) url.searchParams.set("pub_year_max", String(maximumYear));
	} else {
		if (args.category === "news") url.searchParams.set("domain_type", "news");
		if (args.startDate) url.searchParams.set("after_date", args.startDate);
		if (args.endDate) url.searchParams.set("before_date", args.endDate);
	}
	return url.toString();
}

export function parseTinyFishItems(items: unknown[]): RagResult[] {
	const seen = new Set<string>();
	const results: RagResult[] = [];
	for (const value of items) {
		const item = asRecord(value);
		const url = normalizeHttpUrl(asString(item?.url));
		if (!item || !url || seen.has(url)) continue;
		seen.add(url);
		const snippet = asString(item.snippet);
		const year = asNumber(item.year);
		const metadata = {
			siteName: asString(item.site_name),
			publisher: asString(item.publisher),
			authors: Array.isArray(item.authors) ? item.authors.filter((author): author is string => typeof author === "string" && Boolean(author.trim())) : undefined,
			venue: asString(item.venue),
			year,
			citedByCount: asNumber(item.cited_by_count),
			pdfUrl: normalizeHttpUrl(asString(item.pdf_url)),
		};
		const boundedMetadata = Object.fromEntries(Object.entries(metadata).filter(([, entry]) => entry !== undefined));
		results.push({
			id: url,
			url,
			title: asString(item.title) ?? url,
			description: snippet ?? null,
			snippets: snippet ? [snippet] : [],
			date: asString(item.date) ?? (year === undefined ? null : String(year)),
			rank: results.length + 1,
			source: "tinyfish",
			metadata: Object.keys(boundedMetadata).length ? boundedMetadata : null,
			canOpen: true,
		});
	}
	return results;
}

function boundedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(20, Math.trunc(limit ?? 10)));
}

export async function searchTinyFishWeb(args: WebSearchArgs, options: ProviderOptions = {}): Promise<WebSearchResult> {
	const query = args.query.trim();
	if (!query) throw new WebProviderError("query must not be empty", { retriable: false });
	const limit = boundedLimit(args.limit);
	const started = performance.now();
	const results: RagResult[] = [];
	const seen = new Set<string>();

	for (let page = 0; results.length < limit && page <= 10; page++) {
		const payload = asRecord(await requestJson("search", searchUrl(args, page), { method: "GET" }, options, DEFAULT_SEARCH_TIMEOUT_MS));
		const rawItems = Array.isArray(payload?.results) ? payload.results : [];
		const pageItems = parseTinyFishItems(rawItems);
		const previousCount = results.length;
		for (const item of pageItems) {
			if (!item.url || seen.has(item.url)) continue;
			seen.add(item.url);
			results.push({ ...item, rank: results.length + 1 });
			if (results.length >= limit) break;
		}
		if (rawItems.length < SEARCH_PAGE_SIZE || results.length === previousCount) break;
	}

	return {
		provider: "tinyfish",
		tool: "web_search",
		query,
		startDate: args.startDate,
		endDate: args.endDate,
		category: args.category,
		includeDomains: cleanedDomains(args.includeDomains),
		excludeDomains: cleanedDomains(args.excludeDomains),
		maxAgeHours: args.maxAgeHours,
		limit,
		results,
		elapsedMs: performance.now() - started,
	};
}

export async function openTinyFishUrl(url: string, options: ProviderOptions = {}): Promise<OpenUrlResult> {
	const target = normalizeHttpUrl(url);
	if (!target) throw new WebProviderError("TinyFish can only open HTTP(S) URLs", { retriable: false });
	const started = performance.now();
	const payload = asRecord(await requestJson("fetch", TINYFISH_FETCH_API, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			urls: [target],
			format: "markdown",
			links: false,
			image_links: false,
		}),
	}, options, DEFAULT_FETCH_TIMEOUT_MS));
	const result = Array.isArray(payload?.results) ? asRecord(payload.results[0]) : undefined;
	if (!result) {
		const failure = Array.isArray(payload?.errors) ? asRecord(payload.errors[0]) : undefined;
		const message = asString(failure?.error) ?? "TinyFish returned no page content";
		const status = asNumber(failure?.status);
		throw new WebProviderError(message, {
			status,
			blocked: status === 401 || status === 403,
			retriable: status !== 400 && status !== 422,
		});
	}
	const content = asString(result.text);
	if (!content) throw new WebProviderError("TinyFish returned empty page content");
	const failure = detectOpenUrlFailure(content);
	if (failure) throw new WebProviderError(failure.message, { blocked: failure.kind === "blocked" });
	const truncated = truncateText(content);
	return {
		provider: "tinyfish",
		tool: "open_url",
		url: normalizeHttpUrl(asString(result.final_url)) ?? target,
		elapsedMs: performance.now() - started,
		...truncated,
	};
}
