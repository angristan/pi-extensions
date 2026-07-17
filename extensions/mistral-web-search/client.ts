/**
 * Dependency graph:
 * Direct: `node:buffer`, `node:fs`, `node:os`, `node:path`.
 * Used by: `extensions/mistral-web-search/client.test.ts`,
 *   `extensions/mistral-web-search/index.test.ts`, `extensions/mistral-web-search/index.ts`.
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROVIDER_ID = "mistral";
const DEFAULT_API_KEY_ENV = "MISTRAL_API_KEY";
const DEFAULT_BASE_URL = "https://api.mistral.ai";
const DEFAULT_TIMEOUT_MS = 120_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const MAX_SNIPPETS_PER_RESULT = 3;
const MAX_SNIPPET_CHARS = 900;
const MAX_QUERY_CHARS = 2_000;
const MAX_TITLE_CHARS = 600;
const MAX_URL_CHARS = 2_048;
const MAX_SOURCE_CHARS = 200;
const MAX_DATE_CHARS = 100;
const MAX_DISPLAY_RESULTS = 10;

export interface RagResult {
	id: string;
	url: string | null;
	title: string | null;
	description: string | null;
	snippets: string[];
	date: string | null;
	rank: number;
	source: string;
	metadata: Record<string, unknown> | null;
	canOpen: boolean;
}

export interface WebSearchResult {
	provider: "mistral-web-search-mcp";
	tool: "web_search";
	query: string;
	startDate?: string;
	endDate?: string;
	limit: number;
	results: RagResult[];
	elapsedMs: number;
}

export interface NewsSearchResult {
	provider: "mistral-web-search-mcp";
	tool: "news_search";
	query: string;
	startDate?: string;
	endDate?: string;
	lang?: string;
	limit: number;
	results: RagResult[];
	elapsedMs: number;
}

export interface OpenUrlResult {
	provider: "mistral-web-search-mcp";
	tool: "open_url";
	url: string;
	content: string;
	elapsedMs: number;
	truncated: boolean;
	originalBytes: number;
	originalLines: number;
}

export interface SearchDisplayItem {
	title?: string;
	url?: string;
	website?: string;
	searchEngine?: string;
	/** Legacy field retained for older persisted tool results. */
	source?: string;
	rank?: number;
	date?: string;
	description?: string;
	snippets: string[];
	canOpen?: boolean;
}

export interface SearchDisplayDetails {
	query?: string;
	startDate?: string;
	endDate?: string;
	lang?: string;
	searchEngine?: string;
	elapsedMs?: number;
	resultCount: number;
	results: SearchDisplayItem[];
}

interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
}

interface ModelsConfig {
	providers?: Record<string, ProviderConfig>;
}

export interface MistralMcpOptions {
	agentDir?: string;
	providerId?: string;
	baseUrl?: string;
	apiKey?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface WebSearchArgs {
	query: string;
	startDate?: string;
	endDate?: string;
	limit?: number;
}

export interface NewsSearchArgs extends WebSearchArgs {
	lang?: string;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readModelsConfig(dir: string): ModelsConfig | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as ModelsConfig;
	} catch {
		return undefined;
	}
}

function resolveEnvReference(value: string): string | undefined {
	const trimmed = value.trim();
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
	if (braced) return process.env[braced[1]!];
	const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
	if (bare) return process.env[bare[1]!];
	return undefined;
}

function resolveApiKey(reference: string | undefined, fallbackEnv: string): string | undefined {
	if (reference?.trim()) {
		const envValue = resolveEnvReference(reference);
		if (envValue !== undefined) return envValue;
		if (reference.trim().startsWith("!")) {
			// Pi provider configs can support command substitution, but extensions should
			// not execute arbitrary configured commands just to search the web.
			throw new Error("Command-backed Mistral API keys are not supported by mistral_web_search.");
		}
		if (!reference.trim().startsWith("$")) return reference;
	}
	return process.env[fallbackEnv];
}

function connectorEndpoint(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const root = trimmed.replace(/\/v\d+(?:\/.*)?$/i, "");
	return `${root}/v1/connectors-gateway/web_search/mcp`;
}

function textContent(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type?: unknown; text: string } => Boolean(part) && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text);
}

function parseMaybeSse(text: string): unknown {
	if (!text.startsWith("event:") && !text.startsWith("data:")) return JSON.parse(text);
	const data = text
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data) throw new Error("Mistral MCP returned an empty SSE payload.");
	return JSON.parse(data);
}

async function withTimeout<T>(signal: AbortSignal | undefined, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return fn(requestSignal);
}

async function callMcpTool(toolName: string, args: Record<string, unknown>, options: MistralMcpOptions = {}): Promise<{ result: unknown; elapsedMs: number }> {
	const dir = options.agentDir ?? agentDir();
	const provider = readModelsConfig(dir)?.providers?.[options.providerId ?? DEFAULT_PROVIDER_ID];
	const apiKey = options.apiKey ?? resolveApiKey(provider?.apiKey, DEFAULT_API_KEY_ENV);
	if (!apiKey) throw new Error(`${DEFAULT_API_KEY_ENV} is not set.`);

	const baseUrl = options.baseUrl ?? provider?.baseUrl ?? DEFAULT_BASE_URL;
	const timeoutMs = options.timeoutMs ?? Number(process.env.PI_MISTRAL_WEB_SEARCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
	const started = performance.now();

	const payload = await withTimeout(options.signal, timeoutMs, async (requestSignal) => {
		const response = await fetch(connectorEndpoint(baseUrl), {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: Date.now(),
				method: "tools/call",
				params: { name: toolName, arguments: args },
			}),
			signal: requestSignal,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Mistral MCP error: HTTP ${response.status}: ${text || response.statusText}`);
		return parseMaybeSse(text);
	});

	if (!payload || typeof payload !== "object") throw new Error("Mistral MCP returned an invalid JSON-RPC payload.");
	const record = payload as { error?: unknown; result?: unknown };
	if (record.error) throw new Error(`Mistral MCP error: ${JSON.stringify(record.error)}`);
	return { result: record.result, elapsedMs: performance.now() - started };
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseRagResults(result: unknown): RagResult[] {
	const texts = textContent(result);
	if (texts.length === 0) return [];
	const parsed = JSON.parse(texts.join("\n")) as unknown;
	const root = asRecord(parsed);
	if (!root) throw new Error("Mistral MCP search result was not an object.");

	return Object.entries(root)
		.map(([id, value]) => {
			const record = asRecord(value);
			if (!record) return undefined;
			const snippets = Array.isArray(record.snippets)
				? record.snippets.filter((snippet): snippet is string => typeof snippet === "string")
				: [];
			return {
				id,
				url: normalizeHttpUrl(asNullableString(record.url)) ?? null,
				title: asNullableString(record.title),
				description: asNullableString(record.description),
				snippets,
				date: asNullableString(record.date),
				rank: typeof record.rank === "number" ? record.rank : Number.MAX_SAFE_INTEGER,
				source: typeof record.source === "string" && record.source.trim() ? record.source : "unknown",
				metadata: asRecord(record.metadata),
				canOpen: typeof record.can_open === "boolean" ? record.can_open : true,
			} satisfies RagResult;
		})
		.filter((result): result is RagResult => result !== undefined)
		.sort((a, b) => a.rank - b.rank);
}

function trimDate(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(max, Math.trunc(value!)));
}

export async function searchMistralWeb(args: WebSearchArgs | string, options: MistralMcpOptions = {}): Promise<WebSearchResult> {
	const input = typeof args === "string" ? { query: args } : args;
	const query = input.query.trim();
	if (!query) throw new Error("query must not be empty");
	const limit = clampLimit(input.limit, 20, 20);
	const startDate = trimDate(input.startDate);
	const endDate = trimDate(input.endDate);
	const mcpArgs: Record<string, unknown> = { query, limit };
	if (startDate) mcpArgs.start_date = startDate;
	if (endDate) mcpArgs.end_date = endDate;

	const { result, elapsedMs } = await callMcpTool("web_search", mcpArgs, options);
	return {
		provider: "mistral-web-search-mcp",
		tool: "web_search",
		query,
		startDate,
		endDate,
		limit,
		results: parseRagResults(result),
		elapsedMs,
	};
}

export async function searchMistralNews(args: NewsSearchArgs, options: MistralMcpOptions = {}): Promise<NewsSearchResult> {
	const query = args.query.trim();
	if (!query) throw new Error("query must not be empty");
	const limit = clampLimit(args.limit, 10, 400);
	const startDate = trimDate(args.startDate);
	const endDate = trimDate(args.endDate);
	const lang = args.lang?.trim() || undefined;
	const mcpArgs: Record<string, unknown> = { query, limit };
	if (startDate) mcpArgs.start_date = startDate;
	if (endDate) mcpArgs.end_date = endDate;
	if (lang) mcpArgs.lang = lang;

	const { result, elapsedMs } = await callMcpTool("news_search", mcpArgs, options);
	return {
		provider: "mistral-web-search-mcp",
		tool: "news_search",
		query,
		startDate,
		endDate,
		lang,
		limit,
		results: parseRagResults(result),
		elapsedMs,
	};
}

function truncateText(text: string): { content: string; truncated: boolean; originalBytes: number; originalLines: number } {
	const lines = text.split("\n");
	const originalLines = lines.length;
	const originalBytes = Buffer.byteLength(text, "utf8");
	let selected = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
	let truncated = lines.length > MAX_OUTPUT_LINES;
	while (Buffer.byteLength(selected, "utf8") > MAX_OUTPUT_BYTES) {
		selected = selected.slice(0, Math.max(0, Math.floor(selected.length * 0.9)));
		truncated = true;
	}
	if (truncated) {
		selected = `${selected.trimEnd()}\n\n[Content truncated: ${originalLines} line(s), ${originalBytes} byte(s) before truncation.]`;
	}
	return { content: selected, truncated, originalBytes, originalLines };
}

function parseOpenUrlContent(result: unknown): string {
	const text = textContent(result).join("\n").trim();
	if (!text) return "";
	try {
		const parsed = JSON.parse(text) as unknown;
		if (Array.isArray(parsed)) {
			const nested = parsed
				.filter((part): part is { text: string } => Boolean(part) && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")
				.map((part) => part.text)
				.join("\n");
			if (nested.trim()) return nested.trim();
		}
	} catch {
		// Some connector responses are already plain text.
	}
	return text;
}

export interface OpenUrlFailure {
	kind: "blocked" | "failed";
	message: string;
}

export function detectOpenUrlFailure(content: string): OpenUrlFailure | undefined {
	const normalized = stripTerminalControls(content).replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;

	const explicitBlocked = /\bOpen blocked:\s*(.+)$/i.exec(normalized);
	if (explicitBlocked) return { kind: "blocked", message: explicitBlocked[1]!.trim() };
	const explicitFailed = /\bOpen failed:\s*(.+)$/i.exec(normalized);
	if (explicitFailed) return { kind: "failed", message: explicitFailed[1]!.trim() };
	if (/^Timed out while opening this page\b/i.test(normalized)) return { kind: "failed", message: normalized };

	const challengeText = normalized.slice(0, 2_000);
	if (/JavaScript is disabled/i.test(challengeText) && /(?:not a robot|bot verification|requires JavaScript)/i.test(challengeText)) {
		return { kind: "blocked", message: "Page requires JavaScript and bot verification." };
	}
	if (/(?:CAPTCHA|checking your browser|verify (?:that )?you(?:'|’)re (?:a human|not a robot)|security verification)/i.test(challengeText)) {
		return { kind: "blocked", message: "Page requires bot or browser verification." };
	}
	return undefined;
}

export async function openMistralUrl(url: string, options: MistralMcpOptions = {}): Promise<OpenUrlResult> {
	const trimmedUrl = stripTerminalControls(url).trim();
	if (!trimmedUrl) throw new Error("url must not be empty");
	const { result, elapsedMs } = await callMcpTool("open_url", { url: trimmedUrl }, options);
	const content = parseOpenUrlContent(result);
	const failure = detectOpenUrlFailure(content);
	if (failure) throw new Error(`${failure.kind === "blocked" ? "Open blocked" : "Open failed"}: ${failure.message}`);
	const truncated = truncateText(content);
	return {
		provider: "mistral-web-search-mcp",
		tool: "open_url",
		url: trimmedUrl,
		content: truncated.content,
		elapsedMs,
		truncated: truncated.truncated,
		originalBytes: truncated.originalBytes,
		originalLines: truncated.originalLines,
	};
}

function stripTerminalControls(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[P^_].*?(?:\x1b\\|\x07)/gs, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-_]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function shorten(value: string, maxChars: number): string {
	const normalized = stripTerminalControls(value).replace(/\s+/g, " ").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function decodeHtmlEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		hellip: "…",
		ldquo: "“",
		lsquo: "‘",
		lt: "<",
		mdash: "—",
		nbsp: " ",
		ndash: "–",
		quot: "\"",
		rdquo: "”",
		rsquo: "’",
	};
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		const lowered = entity.toLowerCase();
		if (lowered in named) return named[lowered]!;
		const codePoint = lowered.startsWith("#x")
			? Number.parseInt(lowered.slice(2), 16)
			: lowered.startsWith("#")
				? Number.parseInt(lowered.slice(1), 10)
				: Number.NaN;
		if (!Number.isInteger(codePoint) || codePoint < 32 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159) || codePoint > 0x10ffff) return "";
		return String.fromCodePoint(codePoint);
	});
}

export function sanitizeSearchText(value: string, maxChars: number): string {
	return shorten(decodeHtmlEntities(value).replace(/<[^>]*>/g, " "), maxChars);
}

export function normalizeHttpUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const parsed = new URL(stripTerminalControls(value).trim());
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
		return parsed.href;
	} catch {
		return undefined;
	}
}

function websiteFromUrl(url: string | null | undefined): string | undefined {
	const normalized = normalizeHttpUrl(url);
	if (!normalized) return undefined;
	return new URL(normalized).hostname.replace(/^www\./i, "") || undefined;
}

function uniqueSanitizedSnippets(snippets: string[], limit: number): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const snippet of snippets) {
		const sanitized = sanitizeSearchText(snippet, MAX_SNIPPET_CHARS);
		const key = sanitized.toLocaleLowerCase();
		if (!sanitized || seen.has(key)) continue;
		seen.add(key);
		unique.push(sanitized);
		if (unique.length >= limit) break;
	}
	return unique;
}

function formatResultItem(result: RagResult, index: number): string[] {
	const url = normalizeHttpUrl(result.url);
	const lines = [
		`${index + 1}. ${sanitizeSearchText(result.title ?? url ?? result.id, MAX_TITLE_CHARS)}`,
		`   URL: ${url ? shorten(url, MAX_URL_CHARS) : "n/a"}`,
		`   Rank: ${result.rank}`,
		`   Website: ${websiteFromUrl(url) ?? "n/a"}`,
		`   Search engine: ${sanitizeSearchText(result.source, MAX_SOURCE_CHARS)}`,
	];
	if (result.date) lines.push(`   Date: ${sanitizeSearchText(result.date, MAX_DATE_CHARS)}`);
	const snippets = uniqueSanitizedSnippets(result.snippets, MAX_SNIPPETS_PER_RESULT);
	if (snippets.length > 0) {
		lines.push("   Snippets:");
		for (const snippet of snippets) lines.push(`   - ${snippet}`);
	}
	if (!result.canOpen) lines.push("   Can open: false");
	return lines;
}

function fitsSearchOutput(lines: string[]): boolean {
	return lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(lines.join("\n"), "utf8") <= MAX_OUTPUT_BYTES;
}

export function formatSearchResults(result: WebSearchResult | NewsSearchResult): string {
	const lines = [
		`query: ${shorten(result.query, MAX_QUERY_CHARS)}`,
		`provider: ${result.provider}`,
		`tool: ${result.tool}`,
		`limit: ${result.limit}`,
		`elapsed_ms: ${Math.round(result.elapsedMs)}`,
		`result_count: ${result.results.length}`,
	];
	if (result.startDate) lines.push(`start_date: ${shorten(result.startDate, MAX_DATE_CHARS)}`);
	if (result.endDate) lines.push(`end_date: ${shorten(result.endDate, MAX_DATE_CHARS)}`);
	if (result.tool === "news_search" && result.lang) lines.push(`lang: ${shorten(result.lang, MAX_SOURCE_CHARS)}`);
	lines.push("", "results:");
	if (result.results.length === 0) {
		lines.push("No results returned.");
		return lines.join("\n");
	}

	const included: string[][] = [];
	for (let index = 0; index < result.results.length; index++) {
		const block = formatResultItem(result.results[index]!, index);
		if (!fitsSearchOutput([...lines, ...included.flat(), ...block])) break;
		included.push(block);
	}

	if (included.length < result.results.length) {
		let notice = "";
		do {
			notice = `[Results truncated: ${included.length} of ${result.results.length} result(s) shown; remaining results omitted by output limit.]`;
			if (fitsSearchOutput([...lines, ...included.flat(), "", notice])) break;
			included.pop();
		} while (included.length > 0);
		lines.push(...included.flat(), "", notice);
	} else {
		lines.push(...included.flat());
	}
	return lines.join("\n");
}

function createSearchDisplayDetails(result: WebSearchResult | NewsSearchResult): SearchDisplayDetails {
	const results = result.results.slice(0, MAX_DISPLAY_RESULTS).map((item) => ({
		title: sanitizeSearchText(item.title ?? item.url ?? item.id, MAX_TITLE_CHARS),
		url: normalizeHttpUrl(item.url),
		website: websiteFromUrl(item.url),
		searchEngine: sanitizeSearchText(item.source, MAX_SOURCE_CHARS),
		rank: item.rank,
		date: item.date ? sanitizeSearchText(item.date, MAX_DATE_CHARS) : undefined,
		description: item.description ? sanitizeSearchText(item.description, 600) : undefined,
		snippets: uniqueSanitizedSnippets(item.snippets, 1),
		canOpen: item.canOpen ? undefined : false,
	}));
	const searchEngines = new Set(results.map((item) => item.searchEngine).filter((value): value is string => Boolean(value)));
	return {
		query: sanitizeSearchText(result.query, MAX_QUERY_CHARS),
		startDate: result.startDate ? sanitizeSearchText(result.startDate, MAX_DATE_CHARS) : undefined,
		endDate: result.endDate ? sanitizeSearchText(result.endDate, MAX_DATE_CHARS) : undefined,
		lang: result.tool === "news_search" && result.lang ? sanitizeSearchText(result.lang, MAX_SOURCE_CHARS) : undefined,
		searchEngine: searchEngines.size === 1 ? [...searchEngines][0] : undefined,
		elapsedMs: Math.round(result.elapsedMs),
		resultCount: result.results.length,
		results,
	};
}

/** Build bounded agent content and UI details without retaining the raw connector payload. */
export function createSearchToolResult(result: WebSearchResult | NewsSearchResult) {
	return {
		content: [{ type: "text" as const, text: formatSearchResults(result) }],
		details: createSearchDisplayDetails(result),
	};
}

/** Reconstruct display data from legacy tool results that predate bounded details. */
export function parseSearchResultText(text: string): SearchDisplayDetails {
	const details: SearchDisplayDetails = { resultCount: 0, results: [] };
	let current: SearchDisplayItem | undefined;
	let inResults = false;
	for (const line of text.split("\n")) {
		if (line === "results:") {
			inResults = true;
			continue;
		}
		let match = /^query:\s*(.*)$/.exec(line);
		if (match) {
			details.query = match[1];
			continue;
		}
		match = /^start_date:\s*(.*)$/.exec(line);
		if (match) {
			details.startDate = match[1];
			continue;
		}
		match = /^end_date:\s*(.*)$/.exec(line);
		if (match) {
			details.endDate = match[1];
			continue;
		}
		match = /^lang:\s*(.*)$/.exec(line);
		if (match) {
			details.lang = match[1];
			continue;
		}
		match = /^elapsed_ms:\s*(-?\d+(?:\.\d+)?)$/.exec(line);
		if (match) {
			const elapsedMs = Number(match[1]);
			if (Number.isFinite(elapsedMs)) details.elapsedMs = elapsedMs;
			continue;
		}
		match = /^result_count:\s*(\d+)$/.exec(line);
		if (match) {
			details.resultCount = Number(match[1]);
			continue;
		}
		if (!inResults) continue;
		match = /^\d+\.\s(.*)$/.exec(line);
		if (match) {
			current = { title: match[1], snippets: [] };
			details.results.push(current);
			continue;
		}
		if (!current) continue;
		match = /^ {3}URL:\s(.*)$/.exec(line);
		if (match) {
			const url = match[1] === "n/a" ? undefined : normalizeHttpUrl(match[1]);
			if (url) {
				current.url = url;
				current.website = websiteFromUrl(url);
			}
			continue;
		}
		match = /^ {3}Rank:\s(.*)$/.exec(line);
		if (match) {
			const rank = Number(match[1]);
			if (Number.isFinite(rank)) current.rank = rank;
			continue;
		}
		match = /^ {3}Website:\s(.*)$/.exec(line);
		if (match) {
			if (match[1] !== "n/a") current.website = match[1];
			continue;
		}
		match = /^ {3}Search engine:\s(.*)$/.exec(line);
		if (match) {
			current.searchEngine = match[1];
			continue;
		}
		match = /^ {3}Source:\s(.*)$/.exec(line);
		if (match) {
			current.source = match[1];
			current.searchEngine = match[1];
			continue;
		}
		match = /^ {3}Date:\s(.*)$/.exec(line);
		if (match) {
			current.date = match[1];
			continue;
		}
		match = /^ {3}Description:\s(.*)$/.exec(line);
		if (match) {
			current.description = match[1];
			continue;
		}
		match = /^ {3}Can open:\sfalse$/.exec(line);
		if (match) {
			current.canOpen = false;
			continue;
		}
		match = /^ {3}-\s(.*)$/.exec(line);
		if (match) current.snippets.push(match[1]);
	}
	const searchEngines = new Set(details.results.map((item) => item.searchEngine ?? item.source).filter((value): value is string => Boolean(value)));
	if (searchEngines.size === 1) details.searchEngine = [...searchEngines][0];
	return details;
}

export function formatOpenUrlResult(result: OpenUrlResult): string {
	return [
		`url: ${result.url}`,
		`provider: ${result.provider}`,
		`tool: ${result.tool}`,
		`elapsed_ms: ${Math.round(result.elapsedMs)}`,
		`truncated: ${result.truncated}`,
		`original_bytes: ${result.originalBytes}`,
		`original_lines: ${result.originalLines}`,
		"",
		"content:",
		result.content,
	].join("\n");
}
