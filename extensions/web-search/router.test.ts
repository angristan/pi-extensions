import { describe, expect, test } from "bun:test";
import { WebProviderError } from "./provider-error";
import {
	newsProviderOrder,
	openProviderOrder,
	resetRouterStateForTests,
	routeSearch,
} from "./router";
import type { WebProvider, WebSearchResult } from "./types";

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

	test("keeps Mistral news opt-in and Firecrawl PDF fallback opt-in", () => {
		const previous = {
			mistralKey: process.env.MISTRAL_API_KEY,
			news: process.env.PI_WEB_SEARCH_ENABLE_MISTRAL_NEWS,
			newsProvider: process.env.PI_WEB_NEWS_PROVIDER,
			pdf: process.env.PI_WEB_ALLOW_FIRECRAWL_PDF,
			open: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.MISTRAL_API_KEY = "test";
			delete process.env.PI_WEB_SEARCH_ENABLE_MISTRAL_NEWS;
			delete process.env.PI_WEB_NEWS_PROVIDER;
			delete process.env.PI_WEB_ALLOW_FIRECRAWL_PDF;
			process.env.PI_WEB_OPEN_PROVIDER = "firecrawl";
			expect(newsProviderOrder()).toEqual(["exa", "firecrawl"]);
			expect(openProviderOrder("https://example.com/manual.pdf")).not.toContain("firecrawl");
			process.env.PI_WEB_ALLOW_FIRECRAWL_PDF = "1";
			expect(openProviderOrder("https://example.com/manual.pdf")[0]).toBe("firecrawl");
		} finally {
			if (previous.mistralKey === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = previous.mistralKey;
			if (previous.news === undefined) delete process.env.PI_WEB_SEARCH_ENABLE_MISTRAL_NEWS; else process.env.PI_WEB_SEARCH_ENABLE_MISTRAL_NEWS = previous.news;
			if (previous.newsProvider === undefined) delete process.env.PI_WEB_NEWS_PROVIDER; else process.env.PI_WEB_NEWS_PROVIDER = previous.newsProvider;
			if (previous.pdf === undefined) delete process.env.PI_WEB_ALLOW_FIRECRAWL_PDF; else process.env.PI_WEB_ALLOW_FIRECRAWL_PDF = previous.pdf;
			if (previous.open === undefined) delete process.env.PI_WEB_OPEN_PROVIDER; else process.env.PI_WEB_OPEN_PROVIDER = previous.open;
		}
	});
});
