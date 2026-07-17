import { performance } from "node:perf_hooks";
import { compactProviderError, isRetriableProviderError, providerStatus, WebProviderError } from "./provider-error";
import { openExaUrl, searchExaNews, searchExaWeb } from "./providers/exa";
import { hasFirecrawlAccess, openFirecrawlUrl, searchFirecrawlNews, searchFirecrawlWeb } from "./providers/firecrawl";
import { hasMistralAccess, openMistralUrl, searchMistralNews, searchMistralWeb } from "./providers/mistral";
import type {
	NewsSearchArgs,
	NewsSearchResult,
	OpenUrlResult,
	ProviderAttempt,
	ProviderOptions,
	WebProvider,
	WebSearchArgs,
	WebSearchResult,
} from "./types";

const CIRCUIT_MS = 60_000;
const circuits = new Map<string, number>();

function truthy(value: string | undefined): boolean {
	return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function configuredProvider(name: string): WebProvider | undefined {
	const value = process.env[name]?.trim().toLowerCase();
	return value === "exa" || value === "firecrawl" || value === "mistral" ? value : undefined;
}

function available(provider: WebProvider): boolean {
	if (provider === "mistral") return hasMistralAccess();
	if (provider === "firecrawl") return hasFirecrawlAccess();
	return true;
}

function ordered(defaults: WebProvider[], overrideName: string): WebProvider[] {
	const override = configuredProvider(overrideName);
	const values = override ? [override, ...defaults] : defaults;
	return [...new Set(values)].filter(available);
}

function circuitKey(operation: string, provider: WebProvider): string {
	return `${operation}:${provider}`;
}

function circuitOpen(operation: string, provider: WebProvider): boolean {
	const until = circuits.get(circuitKey(operation, provider)) ?? 0;
	if (until <= Date.now()) {
		circuits.delete(circuitKey(operation, provider));
		return false;
	}
	return true;
}

function tripCircuit(operation: string, provider: WebProvider, error: unknown): void {
	if (providerStatus(error) === 429) circuits.set(circuitKey(operation, provider), Date.now() + CIRCUIT_MS);
}

function totalCredits(attempts: ProviderAttempt[]): number | undefined {
	const credits = attempts.reduce((sum, attempt) => sum + (attempt.creditsUsed ?? 0), 0);
	return credits > 0 ? credits : undefined;
}

function failureMessage(label: string, attempts: ProviderAttempt[]): string {
	const failures = attempts.filter((attempt) => attempt.status === "failed");
	return `${label} failed: ${failures.map((attempt) => `${attempt.provider}: ${attempt.error}`).join("; ") || "no provider available"}`;
}

export async function routeSearch<T extends WebSearchResult | NewsSearchResult>(
	operation: "web_search" | "news_search",
	providers: WebProvider[],
	call: (provider: WebProvider) => Promise<T>,
): Promise<T> {
	const started = performance.now();
	const attempts: ProviderAttempt[] = [];
	let emptyResult: T | undefined;
	for (const provider of providers) {
		if (circuitOpen(operation, provider)) {
			attempts.push({ provider, status: "skipped", elapsedMs: 0, error: "temporarily disabled after rate limiting" });
			continue;
		}
		const attemptStarted = performance.now();
		try {
			const result = await call(provider);
			const elapsedMs = performance.now() - attemptStarted;
			const status = result.results.length > 0 ? "success" : "empty";
			attempts.push({ provider, status, elapsedMs, resultCount: result.results.length, creditsUsed: result.creditsUsed });
			if (status === "success") {
				return {
					...result,
					elapsedMs: performance.now() - started,
					attempts,
					creditsUsed: totalCredits(attempts),
				};
			}
			emptyResult = result;
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			const elapsedMs = performance.now() - attemptStarted;
			attempts.push({ provider, status: "failed", elapsedMs, error: compactProviderError(error) });
			tripCircuit(operation, provider, error);
			if (!isRetriableProviderError(error)) break;
		}
	}
	if (emptyResult) {
		return {
			...emptyResult,
			elapsedMs: performance.now() - started,
			attempts,
			creditsUsed: totalCredits(attempts),
		};
	}
	throw new WebProviderError(failureMessage(operation === "web_search" ? "Web search" : "News search", attempts));
}

export function webProviderOrder(): WebProvider[] {
	return ordered(["exa", "mistral", "firecrawl"], "PI_WEB_SEARCH_PROVIDER");
}

export function newsProviderOrder(): WebProvider[] {
	const defaults: WebProvider[] = ["exa", "firecrawl"];
	if (truthy(process.env.PI_WEB_SEARCH_ENABLE_MISTRAL_NEWS)) defaults.push("mistral");
	return ordered(defaults, "PI_WEB_NEWS_PROVIDER");
}

export function openProviderOrder(url: string): WebProvider[] {
	if (!/^https?:\/\//i.test(url)) return hasMistralAccess() ? ["mistral"] : [];
	const pdf = /\.pdf(?:$|[?#])/i.test(url);
	const defaults: WebProvider[] = pdf ? ["exa", "mistral"] : ["exa", "firecrawl", "mistral"];
	const providers = ordered(defaults, "PI_WEB_OPEN_PROVIDER");
	if (pdf && !truthy(process.env.PI_WEB_ALLOW_FIRECRAWL_PDF)) return providers.filter((provider) => provider !== "firecrawl");
	return providers;
}

export async function searchWeb(args: WebSearchArgs, options: ProviderOptions = {}): Promise<WebSearchResult> {
	return routeSearch("web_search", webProviderOrder(), (provider) => {
		if (provider === "exa") return searchExaWeb(args, options);
		if (provider === "firecrawl") return searchFirecrawlWeb(args, options);
		return searchMistralWeb(args, options);
	});
}

export async function searchNews(args: NewsSearchArgs, options: ProviderOptions = {}): Promise<NewsSearchResult> {
	return routeSearch("news_search", newsProviderOrder(), (provider) => {
		if (provider === "exa") return searchExaNews(args, options);
		if (provider === "firecrawl") return searchFirecrawlNews(args, options);
		return searchMistralNews(args, options);
	});
}

export async function openUrl(url: string, options: ProviderOptions = {}): Promise<OpenUrlResult> {
	const providers = openProviderOrder(url.trim());
	const started = performance.now();
	const attempts: ProviderAttempt[] = [];
	for (const provider of providers) {
		if (circuitOpen("open_url", provider)) {
			attempts.push({ provider, status: "skipped", elapsedMs: 0, error: "temporarily disabled after rate limiting" });
			continue;
		}
		const attemptStarted = performance.now();
		try {
			const result = provider === "exa"
				? await openExaUrl(url, options)
				: provider === "firecrawl"
					? await openFirecrawlUrl(url, options)
					: await openMistralUrl(url, options);
			attempts.push({ provider, status: "success", elapsedMs: performance.now() - attemptStarted, creditsUsed: result.creditsUsed });
			return {
				...result,
				elapsedMs: performance.now() - started,
				attempts,
				creditsUsed: totalCredits(attempts),
			};
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			attempts.push({ provider, status: "failed", elapsedMs: performance.now() - attemptStarted, error: compactProviderError(error) });
			tripCircuit("open_url", provider, error);
			if (!isRetriableProviderError(error)) break;
		}
	}
	throw new WebProviderError(failureMessage("Open URL", attempts));
}

export function webStatus() {
	const now = Date.now();
	return {
		providers: {
			exa: { available: true, keyed: Boolean(process.env.EXA_API_KEY?.trim()) },
			firecrawl: { available: hasFirecrawlAccess(), keyed: hasFirecrawlAccess() },
			mistral: { available: hasMistralAccess(), keyed: hasMistralAccess() },
		},
		routes: {
			web: webProviderOrder(),
			news: newsProviderOrder(),
			open: openProviderOrder("https://example.com"),
			pdf: openProviderOrder("https://example.com/file.pdf"),
		},
		circuits: [...circuits.entries()].filter(([, until]) => until > now).map(([key, until]) => ({ key, retryInMs: until - now })),
	};
}

export function resetRouterStateForTests(): void {
	circuits.clear();
}
