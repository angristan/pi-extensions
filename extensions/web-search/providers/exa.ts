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

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_TIMEOUT_MS = 20_000;
const RATE_LIMIT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000] as const;
const RATE_LIMIT_RETRY_BUDGET_MS = 30_000;
const RATE_LIMIT_JITTER_MS = 500;

function requestHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
	};
	const key = process.env.EXA_API_KEY?.trim();
	if (key) headers["x-api-key"] = key;
	return headers;
}

function endpoint(tool: string): string {
	if (tool !== "web_search_advanced_exa") return EXA_MCP_URL;
	const url = new URL(EXA_MCP_URL);
	url.searchParams.set("tools", tool);
	return url.toString();
}

function parseMaybeSse(text: string): any {
	if (!text.startsWith("event:") && !text.startsWith("data:")) return JSON.parse(text);
	const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
	if (!data) throw new WebProviderError("Exa returned an empty SSE payload");
	return JSON.parse(data);
}

function mcpToolError(text: string): WebProviderError {
	const detail = text.slice(0, 500) || "Unknown tool failure";
	const status = Number(/\b([45]\d{2})\b/.exec(detail)?.[1]);
	const knownStatus = Number.isInteger(status) ? status : undefined;
	return new WebProviderError(`Exa MCP tool error: ${detail}`, {
		status: knownStatus,
		retriable: knownStatus === undefined || knownStatus === 408 || knownStatus === 429 || knownStatus >= 500,
	});
}

function retryAfterMs(response: Response): number | undefined {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
	if (delayMs <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function callExa(tool: string, args: Record<string, unknown>, options: ProviderOptions = {}): Promise<{ text: string; elapsedMs: number }> {
	const started = performance.now();
	for (let attempt = 0; ; attempt++) {
		const remainingBudgetMs = RATE_LIMIT_RETRY_BUDGET_MS - (performance.now() - started);
		if (remainingBudgetMs <= 0) throw new WebProviderError("Exa retry budget exhausted");
		const requestTimeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, Math.floor(remainingBudgetMs)));
		let response: Response;
		try {
			response = await fetch(endpoint(tool), {
				method: "POST",
				headers: requestHeaders(),
				body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } }),
				signal: combineSignals(options.signal, requestTimeoutMs),
			});
		} catch (error) {
			if (options.signal?.aborted) throw options.signal.reason ?? error;
			throw new WebProviderError(`Exa request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		const raw = await response.text();
		if (response.status === 429 && attempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
			const delayMs = retryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAYS_MS[attempt]!;
			const jitterMs = Math.floor(Math.random() * (RATE_LIMIT_JITTER_MS + 1));
			const totalDelayMs = delayMs + jitterMs;
			const remainingBudgetMs = RATE_LIMIT_RETRY_BUDGET_MS - (performance.now() - started);
			if (totalDelayMs < remainingBudgetMs) {
				await waitForRetry(totalDelayMs, options.signal);
				continue;
			}
		}
		if (!response.ok) {
			throw new WebProviderError(`Exa HTTP ${response.status}: ${raw.slice(0, 300) || response.statusText}`, {
				status: response.status,
				retriable: response.status === 429 || response.status >= 500,
			});
		}
		let payload: any;
		try {
			payload = parseMaybeSse(raw);
		} catch (error) {
			throw new WebProviderError("Exa returned invalid JSON", { cause: error });
		}
		if (payload?.error) throw new WebProviderError(`Exa MCP error: ${JSON.stringify(payload.error).slice(0, 500)}`);
		const text = (payload?.result?.content ?? [])
			.filter((part: any) => typeof part?.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
		if (payload?.result?.isError === true) throw mcpToolError(text);
		return { text, elapsedMs: performance.now() - started };
	}
}

function canonicalResultUrl(raw: string): string | undefined {
	const normalized = normalizeHttpUrl(raw);
	if (!normalized) return undefined;
	const url = new URL(normalized);
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) {
		if (/^(?:utm_.+|ref|referrer|source|via|lid|dub_.+)$/i.test(key)) url.searchParams.delete(key);
	}
	return url.toString();
}

function snippetsFromBlock(block: string): string[] {
	const highlights = block.replace(/^Title:.*$/m, "").replace(/^URL:.*$/m, "").replace(/^Published:.*$/m, "").replace(/^Author:.*$/m, "").replace(/^Highlights:\s*/m, "").trim();
	return highlights.split(/\n\s*\n|\n(?=#{1,6}\s)/).map((value) => value.trim()).filter(Boolean).slice(0, 3);
}

export function parseExaSearchText(text: string): RagResult[] {
	const seen = new Set<string>();
	const results: RagResult[] = [];
	for (const block of text.split(/\n\s*---\s*\n/g)) {
		const rawUrl = /^URL:\s*(.*)$/m.exec(block)?.[1]?.trim();
		const url = rawUrl ? canonicalResultUrl(rawUrl) : undefined;
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const snippets = snippetsFromBlock(block);
		results.push({
			id: url,
			url,
			title: /^Title:\s*(.*)$/m.exec(block)?.[1]?.trim() || url,
			description: snippets.join("\n\n") || null,
			snippets,
			date: /^Published:\s*(.*)$/m.exec(block)?.[1]?.trim() || null,
			rank: results.length + 1,
			source: "exa",
			metadata: null,
			canOpen: true,
		});
	}
	return results;
}

export function parseExaAdvancedSearchText(text: string): RagResult[] {
	let payload: any;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		throw new WebProviderError("Exa advanced search returned invalid JSON", { cause: error });
	}
	const seen = new Set<string>();
	const results: RagResult[] = [];
	for (const item of Array.isArray(payload?.results) ? payload.results : []) {
		const url = canonicalResultUrl(String(item?.url ?? item?.id ?? ""));
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const snippets = Array.isArray(item?.highlights)
			? item.highlights.filter((value: unknown): value is string => typeof value === "string" && Boolean(value.trim()))
			: [];
		results.push({
			id: String(item?.id ?? url),
			url,
			title: typeof item?.title === "string" && item.title.trim() ? item.title.trim() : url,
			description: snippets.join("\n\n") || null,
			snippets,
			date: typeof item?.publishedDate === "string" && item.publishedDate.trim() ? item.publishedDate.trim() : null,
			rank: results.length + 1,
			source: "exa",
			metadata: null,
			canOpen: true,
		});
	}
	return results;
}

function boundedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(20, Math.trunc(limit ?? 10)));
}

function cleanedDomains(values: string[] | undefined): string[] | undefined {
	const domains = values?.map((value) => value.trim()).filter(Boolean);
	return domains?.length ? domains : undefined;
}

function usesAdvancedSearch(args: WebSearchArgs): boolean {
	return Boolean(
		args.startDate
		|| args.endDate
		|| args.category
		|| cleanedDomains(args.includeDomains)
		|| cleanedDomains(args.excludeDomains)
		|| args.maxAgeHours !== undefined,
	);
}

function publicationBoundary(date: string, endExclusive: boolean): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) return date;
	const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (endExclusive ? 1 : 0));
	return new Date(timestamp).toISOString();
}

function advancedSearchArgs(args: WebSearchArgs, query: string, limit: number): Record<string, unknown> {
	const includeDomains = cleanedDomains(args.includeDomains);
	const excludeDomains = cleanedDomains(args.excludeDomains);
	const hasDomainFilters = Boolean(includeDomains || excludeDomains);
	const publicationDomainSearch = args.category === "publication" && hasDomainFilters;
	const nativeCategory = publicationDomainSearch ? undefined : args.category;
	const restrictedCategory = nativeCategory === "company" || nativeCategory === "people";
	return {
		query: publicationDomainSearch ? `Scholarly publication about ${query}` : query,
		numResults: limit,
		type: "auto",
		...(nativeCategory ? { category: nativeCategory } : {}),
		...(!restrictedCategory && includeDomains ? { includeDomains } : {}),
		...(!restrictedCategory && excludeDomains ? { excludeDomains } : {}),
		...(!restrictedCategory && args.startDate ? { startPublishedDate: publicationBoundary(args.startDate, false) } : {}),
		...(!restrictedCategory && args.endDate ? { endPublishedDate: publicationBoundary(args.endDate, true) } : {}),
		...(args.maxAgeHours !== undefined ? { maxAgeHours: args.maxAgeHours } : {}),
		// The hosted advanced MCP wrapper always requests text. Keep that side
		// channel bounded, then expose only source-grounded highlights to the model.
		textMaxCharacters: 2_000,
		enableHighlights: true,
		highlightsQuery: query,
	};
}

export async function searchExaWeb(args: WebSearchArgs, options: ProviderOptions = {}): Promise<WebSearchResult> {
	const query = args.query.trim();
	const limit = boundedLimit(args.limit);
	const advanced = usesAdvancedSearch(args);
	const response = advanced
		? await callExa("web_search_advanced_exa", advancedSearchArgs(args, query, limit), options)
		: await callExa("web_search_exa", { query, numResults: limit }, options);
	return {
		provider: "exa",
		tool: "web_search",
		query,
		startDate: args.startDate,
		endDate: args.endDate,
		category: args.category,
		includeDomains: cleanedDomains(args.includeDomains),
		excludeDomains: cleanedDomains(args.excludeDomains),
		maxAgeHours: args.maxAgeHours,
		limit,
		results: (advanced ? parseExaAdvancedSearchText(response.text) : parseExaSearchText(response.text)).slice(0, limit),
		elapsedMs: response.elapsedMs,
	};
}

export async function openExaUrl(url: string, options: ProviderOptions = {}): Promise<OpenUrlResult> {
	const target = normalizeHttpUrl(url);
	if (!target) throw new WebProviderError("Exa can only open HTTP(S) URLs", { retriable: false });
	const response = await callExa("web_fetch_exa", { urls: [target], maxCharacters: 50_000 }, options);
	if (!response.text) throw new WebProviderError("Exa returned empty page content");
	const failure = detectOpenUrlFailure(response.text);
	if (failure) throw new WebProviderError(failure.message, { blocked: failure.kind === "blocked" });
	const truncated = truncateText(response.text);
	return { provider: "exa", tool: "open_url", url: target, elapsedMs: response.elapsedMs, ...truncated };
}
