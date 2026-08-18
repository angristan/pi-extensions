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
			response = await fetch(EXA_MCP_URL, {
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

function boundedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(20, Math.trunc(limit ?? 10)));
}

function datePhrase(startDate?: string, endDate?: string): string {
	if (startDate && endDate) return ` published from ${startDate} through ${endDate}`;
	if (startDate) return ` published on or after ${startDate}`;
	if (endDate) return ` published on or before ${endDate}`;
	return "";
}

function filterKnownDates(results: RagResult[], startDate?: string, endDate?: string): RagResult[] {
	const start = startDate ? Date.parse(`${startDate}T00:00:00Z`) : undefined;
	const end = endDate ? Date.parse(`${endDate}T23:59:59Z`) : undefined;
	return results.filter((result) => {
		if (!result.date || result.date === "N/A") return true;
		const timestamp = Date.parse(result.date);
		if (!Number.isFinite(timestamp)) return true;
		return (start === undefined || timestamp >= start) && (end === undefined || timestamp <= end);
	}).map((result, index) => ({ ...result, rank: index + 1 }));
}

export async function searchExaWeb(args: WebSearchArgs, options: ProviderOptions = {}): Promise<WebSearchResult> {
	const query = args.query.trim();
	const limit = boundedLimit(args.limit);
	const enriched = `${query}${datePhrase(args.startDate, args.endDate)}`;
	const response = await callExa("web_search_exa", { query: enriched, numResults: limit }, options);
	return {
		provider: "exa",
		tool: "web_search",
		query,
		startDate: args.startDate,
		endDate: args.endDate,
		limit,
		results: filterKnownDates(parseExaSearchText(response.text), args.startDate, args.endDate).slice(0, limit),
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
