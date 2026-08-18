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

interface DomainRule {
	host: string;
	path: string;
	wildcard: boolean;
}

function domainRule(value: string): DomainRule | undefined {
	let raw = value.trim().toLowerCase();
	if (!raw) return undefined;
	const wildcard = raw.startsWith("*.");
	if (wildcard) raw = raw.slice(2);
	try {
		const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
		const path = parsed.pathname.replace(/\/$/, "");
		return { host: parsed.hostname, path: path === "/" ? "" : path, wildcard };
	} catch {
		return undefined;
	}
}

function matchesDomain(url: string | null, rule: DomainRule): boolean {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const hostMatches = rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host || host.endsWith(`.${rule.host}`);
		if (!hostMatches || !rule.path) return hostMatches;
		return parsed.pathname === rule.path || parsed.pathname.startsWith(`${rule.path}/`);
	} catch {
		return false;
	}
}

function knownDateInRange(date: string | null, startDate?: string, endDate?: string): boolean {
	if (!date || /^(?:n\/?a|none|null|unknown)$/i.test(date.trim())) return true;
	const timestamp = Date.parse(date);
	if (!Number.isFinite(timestamp)) return true;
	const start = startDate ? Date.parse(`${startDate}T00:00:00Z`) : undefined;
	const end = endDate ? Date.parse(`${endDate}T23:59:59.999Z`) : undefined;
	return (start === undefined || timestamp >= start) && (end === undefined || timestamp <= end);
}

function cleanedDomains(values: string[] | undefined): string[] | undefined {
	const domains = values?.map((value) => value.trim()).filter(Boolean);
	return domains?.length ? domains : undefined;
}

export function applySearchFilters(result: WebSearchResult, args: WebSearchArgs): WebSearchResult {
	const includeDomains = cleanedDomains(args.includeDomains);
	const excludeDomains = cleanedDomains(args.excludeDomains);
	const includeRules = includeDomains?.map(domainRule).filter((rule): rule is DomainRule => Boolean(rule)) ?? [];
	const excludeRules = excludeDomains?.map(domainRule).filter((rule): rule is DomainRule => Boolean(rule)) ?? [];
	const hasIncludeConstraint = Boolean(includeDomains?.length);
	const results = result.results
		.filter((item) => !hasIncludeConstraint || includeRules.some((rule) => matchesDomain(item.url, rule)))
		.filter((item) => !excludeRules.some((rule) => matchesDomain(item.url, rule)))
		.filter((item) => knownDateInRange(item.date, args.startDate, args.endDate))
		.map((item, index) => ({ ...item, rank: index + 1 }));
	return {
		...result,
		query: args.query.trim(),
		startDate: args.startDate,
		endDate: args.endDate,
		category: args.category,
		includeDomains,
		excludeDomains,
		maxAgeHours: args.maxAgeHours,
		results,
	};
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
	return routeSearch(webProviderOrder(args.provider), async (provider) => {
		const result = provider === "exa"
			? await searchExaWeb(args, options)
			: provider === "firecrawl"
				? await searchFirecrawlWeb(args, options)
				: await searchMistralWeb(args, options);
		return applySearchFilters(result, args);
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
