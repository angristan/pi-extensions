import { performance } from "node:perf_hooks";
import { compactProviderError, isRetriableProviderError, WebProviderError } from "./provider-error";
import { openExaUrl, searchExaWeb } from "./providers/exa";
import { hasFirecrawlAccess, openFirecrawlUrl, searchFirecrawlWeb } from "./providers/firecrawl";
import { hasMistralAccess, openMistralUrl, searchMistralWeb } from "./providers/mistral";
import type {
	OpenUrlResult,
	ProviderAttempt,
	ProviderOptions,
	WebProvider,
	WebSearchArgs,
	WebSearchResult,
} from "./types";

const DEFAULT_PROVIDER_ORDER: WebProvider[] = ["exa", "firecrawl", "mistral"];

function normalizedProvider(value: string | undefined): WebProvider | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "exa" || normalized === "firecrawl" || normalized === "mistral" ? normalized : undefined;
}

function configuredProvider(name: string): WebProvider | undefined {
	return normalizedProvider(process.env[name]);
}

function available(provider: WebProvider): boolean {
	if (provider === "mistral") return hasMistralAccess();
	if (provider === "firecrawl") return hasFirecrawlAccess();
	return true;
}

function ordered(overrideName: string, preferredProvider?: string): WebProvider[] {
	const preferred = normalizedProvider(preferredProvider);
	const override = configuredProvider(overrideName);
	return [...new Set([preferred, override, ...DEFAULT_PROVIDER_ORDER].filter((provider): provider is WebProvider => Boolean(provider)))].filter(available);
}

function totalCredits(attempts: ProviderAttempt[]): number | undefined {
	const credits = attempts.reduce((sum, attempt) => sum + (attempt.creditsUsed ?? 0), 0);
	return credits > 0 ? credits : undefined;
}

function failureMessage(label: string, attempts: ProviderAttempt[]): string {
	const failures = attempts.filter((attempt) => attempt.status === "failed");
	return `${label} failed: ${failures.map((attempt) => `${attempt.provider}: ${attempt.error}`).join("; ") || "no provider available"}`;
}

export async function routeSearch<T extends WebSearchResult>(
	providers: WebProvider[],
	call: (provider: WebProvider) => Promise<T>,
): Promise<T> {
	const started = performance.now();
	const attempts: ProviderAttempt[] = [];
	let emptyResult: T | undefined;
	for (const provider of providers) {
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
	throw new WebProviderError(failureMessage("Web search", attempts));
}

export function webProviderOrder(preferredProvider?: string): WebProvider[] {
	return ordered("PI_WEB_SEARCH_PROVIDER", preferredProvider);
}

export function openProviderOrder(url: string, preferredProvider?: string): WebProvider[] {
	if (!/^https?:\/\//i.test(url)) return hasMistralAccess() ? ["mistral"] : [];
	return ordered("PI_WEB_OPEN_PROVIDER", preferredProvider);
}

export async function searchWeb(args: WebSearchArgs, options: ProviderOptions = {}): Promise<WebSearchResult> {
	return routeSearch(webProviderOrder(args.provider), (provider) => {
		if (provider === "exa") return searchExaWeb(args, options);
		if (provider === "firecrawl") return searchFirecrawlWeb(args, options);
		return searchMistralWeb(args, options);
	});
}

export async function openUrl(url: string, options: ProviderOptions = {}, preferredProvider?: string): Promise<OpenUrlResult> {
	const providers = openProviderOrder(url.trim(), preferredProvider);
	const started = performance.now();
	const attempts: ProviderAttempt[] = [];
	for (const provider of providers) {
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
			if (!isRetriableProviderError(error)) break;
		}
	}
	throw new WebProviderError(failureMessage("Open URL", attempts));
}

export function webStatus() {
	return {
		providers: {
			exa: { available: true, keyed: Boolean(process.env.EXA_API_KEY?.trim()) },
			firecrawl: { available: hasFirecrawlAccess(), keyed: hasFirecrawlAccess() },
			mistral: { available: hasMistralAccess(), keyed: hasMistralAccess() },
		},
		routes: {
			web: webProviderOrder(),
			open: openProviderOrder("https://example.com"),
		},
	};
}
