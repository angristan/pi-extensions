import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { WebProviderError } from "./provider-error";
import {
	newsProviderOrder,
	openProviderOrder,
	resetRouterStateForTests,
	routeSearch,
	webProviderOrder,
	webStatus,
} from "./router";
import type { WebProvider, WebSearchResult } from "./types";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function result(provider: WebProvider, count = 1): WebSearchResult {
	return {
		provider,
		tool: "web_search",
		query: "test",
		limit: 10,
		elapsedMs: 10,
		results: Array.from({ length: count }, (_, index) => ({
			id: String(index),
			url: `https://example.com/${index}`,
			title: `Result ${index}`,
			description: null,
			snippets: [],
			date: null,
			rank: index + 1,
			source: provider,
			metadata: null,
			canOpen: true,
		})),
	};
}

describe("provider router", () => {
	test("falls back sequentially and records each attempt", async () => {
		resetRouterStateForTests();
		const calls: WebProvider[] = [];
		const routed = await routeSearch("web_search", ["exa", "firecrawl"], async (provider) => {
			calls.push(provider);
			if (provider === "exa") throw new WebProviderError("temporary outage", { status: 503 });
			return result(provider);
		});

		expect(calls).toEqual(["exa", "firecrawl"]);
		expect(routed.provider).toBe("firecrawl");
		expect(routed.attempts?.map((attempt) => [attempt.provider, attempt.status])).toEqual([
			["exa", "failed"],
			["firecrawl", "success"],
		]);
	});

	test("falls back after empty results", async () => {
		resetRouterStateForTests();
		const routed = await routeSearch("web_search", ["exa", "firecrawl"], async (provider) => result(provider, provider === "exa" ? 0 : 1));
		expect(routed.provider).toBe("firecrawl");
		expect(routed.attempts?.map((attempt) => attempt.status)).toEqual(["empty", "success"]);
	});

	test("does not continue after a non-retriable input error", async () => {
		resetRouterStateForTests();
		const calls: WebProvider[] = [];
		await expect(routeSearch("web_search", ["exa", "firecrawl"], async (provider) => {
			calls.push(provider);
			throw new WebProviderError("invalid request", { status: 400, retriable: false });
		})).rejects.toThrow("invalid request");
		expect(calls).toEqual(["exa"]);
	});

	test("temporarily skips a provider after rate limiting", async () => {
		resetRouterStateForTests();
		await routeSearch("web_search", ["exa", "firecrawl"], async (provider) => {
			if (provider === "exa") throw new WebProviderError("rate limited", { status: 429 });
			return result(provider);
		});
		const calls: WebProvider[] = [];
		const routed = await routeSearch("web_search", ["exa", "firecrawl"], async (provider) => {
			calls.push(provider);
			return result(provider);
		});
		expect(calls).toEqual(["firecrawl"]);
		expect(routed.attempts?.[0]).toMatchObject({ provider: "exa", status: "skipped" });
	});

	test("omits Firecrawl and Mistral when credentials are missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-search-test-"));
		const previous = {
			agentDir: process.env.PI_CODING_AGENT_DIR,
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
			searchProvider: process.env.PI_WEB_SEARCH_PROVIDER,
			newsProvider: process.env.PI_WEB_NEWS_PROVIDER,
			openProvider: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			delete process.env.FIRECRAWL_API_KEY;
			delete process.env.MISTRAL_API_KEY;
			delete process.env.PI_WEB_SEARCH_PROVIDER;
			delete process.env.PI_WEB_NEWS_PROVIDER;
			delete process.env.PI_WEB_OPEN_PROVIDER;

			expect(webProviderOrder()).toEqual(["exa"]);
			expect(newsProviderOrder()).toEqual(["exa"]);
			expect(openProviderOrder("https://example.com/docs")).toEqual(["exa"]);
			expect(openProviderOrder("mistral-news-article-id")).toEqual([]);
			expect(webStatus().providers.firecrawl).toEqual({ available: false, keyed: false });
			expect(webStatus().providers.mistral).toEqual({ available: false, keyed: false });
			expect(webStatus().routes).not.toHaveProperty("pdf");
		} finally {
			restoreEnv("PI_CODING_AGENT_DIR", previous.agentDir);
			restoreEnv("FIRECRAWL_API_KEY", previous.firecrawlKey);
			restoreEnv("MISTRAL_API_KEY", previous.mistralKey);
			restoreEnv("PI_WEB_SEARCH_PROVIDER", previous.searchProvider);
			restoreEnv("PI_WEB_NEWS_PROVIDER", previous.newsProvider);
			restoreEnv("PI_WEB_OPEN_PROVIDER", previous.openProvider);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("uses one credential-gated order for web, news, open, and PDFs", () => {
		const previous = {
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
			searchProvider: process.env.PI_WEB_SEARCH_PROVIDER,
			newsProvider: process.env.PI_WEB_NEWS_PROVIDER,
			openProvider: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.FIRECRAWL_API_KEY = "test-firecrawl";
			process.env.MISTRAL_API_KEY = "test-mistral";
			delete process.env.PI_WEB_SEARCH_PROVIDER;
			delete process.env.PI_WEB_NEWS_PROVIDER;
			delete process.env.PI_WEB_OPEN_PROVIDER;

			const route = ["exa", "firecrawl", "mistral"];
			expect(webProviderOrder()).toEqual(route);
			expect(newsProviderOrder()).toEqual(route);
			expect(openProviderOrder("https://example.com/docs")).toEqual(route);
			expect(openProviderOrder("https://example.com/manual.pdf")).toEqual(route);
		} finally {
			restoreEnv("FIRECRAWL_API_KEY", previous.firecrawlKey);
			restoreEnv("MISTRAL_API_KEY", previous.mistralKey);
			restoreEnv("PI_WEB_SEARCH_PROVIDER", previous.searchProvider);
			restoreEnv("PI_WEB_NEWS_PROVIDER", previous.newsProvider);
			restoreEnv("PI_WEB_OPEN_PROVIDER", previous.openProvider);
		}
	});

	test("lets a per-call provider preference take precedence over env overrides", () => {
		const previous = {
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
			searchProvider: process.env.PI_WEB_SEARCH_PROVIDER,
			newsProvider: process.env.PI_WEB_NEWS_PROVIDER,
			openProvider: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.FIRECRAWL_API_KEY = "test-firecrawl";
			process.env.MISTRAL_API_KEY = "test-mistral";
			process.env.PI_WEB_SEARCH_PROVIDER = "mistral";
			process.env.PI_WEB_NEWS_PROVIDER = "mistral";
			process.env.PI_WEB_OPEN_PROVIDER = "mistral";

			expect(webProviderOrder("firecrawl")).toEqual(["firecrawl", "mistral", "exa"]);
			expect(newsProviderOrder("firecrawl")).toEqual(["firecrawl", "mistral", "exa"]);
			expect(openProviderOrder("https://example.com/docs", "firecrawl")).toEqual(["firecrawl", "mistral", "exa"]);
			expect(webProviderOrder("unknown")).toEqual(["mistral", "exa", "firecrawl"]);
		} finally {
			restoreEnv("FIRECRAWL_API_KEY", previous.firecrawlKey);
			restoreEnv("MISTRAL_API_KEY", previous.mistralKey);
			restoreEnv("PI_WEB_SEARCH_PROVIDER", previous.searchProvider);
			restoreEnv("PI_WEB_NEWS_PROVIDER", previous.newsProvider);
			restoreEnv("PI_WEB_OPEN_PROVIDER", previous.openProvider);
		}
	});
});
