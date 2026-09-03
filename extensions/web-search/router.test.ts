import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WebProviderError } from "./provider-error";
import {
	applySearchFilters,
	openProviderOrder,
	routeSearch,
	webProviderOrder,
	webStatus,
} from "./router";
import type { WebProvider, WebSearchResult } from "./types";

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let hermeticAgentDirectory: string;

beforeEach(() => {
	hermeticAgentDirectory = mkdtempSync(join(tmpdir(), "pi-web-router-agent-test-"));
	process.env.PI_CODING_AGENT_DIR = hermeticAgentDirectory;
});

afterEach(() => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	rmSync(hermeticAgentDirectory, { recursive: true, force: true });
});

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
	test("enforces domain paths and known dates after provider search", () => {
		const unfiltered = result("firecrawl", 0);
		unfiltered.results = [
			{ ...result("firecrawl").results[0]!, url: "https://docs.example.com/api/guide", date: "2026-08-12", rank: 8 },
			{ ...result("firecrawl").results[0]!, url: "https://example.com/blog", date: "2026-08-12", rank: 9 },
			{ ...result("firecrawl").results[0]!, url: "https://blocked.example.com/api/guide", date: "2026-08-12", rank: 10 },
			{ ...result("firecrawl").results[0]!, url: "https://example.com/api/old", date: "2025-01-01", rank: 11 },
		];
		const filtered = applySearchFilters(unfiltered, {
			query: "API guide",
			startDate: "2026-08-01",
			endDate: "2026-08-18",
			category: "publication",
			includeDomains: ["example.com/api"],
			excludeDomains: ["blocked.example.com"],
			maxAgeHours: 24,
		});
		expect(filtered.results.map((item) => item.url)).toEqual(["https://docs.example.com/api/guide"]);
		expect(filtered.results[0]?.rank).toBe(1);
		expect(filtered).toMatchObject({
			query: "API guide",
			category: "publication",
			includeDomains: ["example.com/api"],
			excludeDomains: ["blocked.example.com"],
			maxAgeHours: 24,
		});
	});

	test("keeps year-only publications when their year overlaps the requested dates", () => {
		const unfiltered = result("tinyfish");
		unfiltered.results[0] = { ...unfiltered.results[0]!, date: "2026" };
		expect(applySearchFilters(unfiltered, {
			query: "web agents",
			startDate: "2026-06-01",
			endDate: "2026-06-30",
		}).results).toHaveLength(1);
	});

	test("falls back sequentially and records each attempt", async () => {
		const calls: WebProvider[] = [];
		const routed = await routeSearch(["exa", "firecrawl"], async (provider) => {
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
		const routed = await routeSearch(["exa", "firecrawl"], async (provider) => result(provider, provider === "exa" ? 0 : 1));
		expect(routed.provider).toBe("firecrawl");
		expect(routed.attempts?.map((attempt) => attempt.status)).toEqual(["empty", "success"]);
	});

	test("does not continue after a non-retriable input error", async () => {
		const calls: WebProvider[] = [];
		await expect(routeSearch(["exa", "firecrawl"], async (provider) => {
			calls.push(provider);
			throw new WebProviderError("invalid request", { status: 400, retriable: false });
		})).rejects.toThrow("invalid request");
		expect(calls).toEqual(["exa"]);
	});

	test("tries a rate-limited provider again on the next search", async () => {
		await routeSearch(["exa", "firecrawl"], async (provider) => {
			if (provider === "exa") throw new WebProviderError("rate limited", { status: 429 });
			return result(provider);
		});
		const calls: WebProvider[] = [];
		const routed = await routeSearch(["exa", "firecrawl"], async (provider) => {
			calls.push(provider);
			return result(provider);
		});
		expect(calls).toEqual(["exa"]);
		expect(routed.provider).toBe("exa");
		expect(routed.attempts?.[0]).toMatchObject({ provider: "exa", status: "success" });
	});

	test("omits keyed providers when credentials are missing", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-web-search-test-"));
		const previous = {
			agentDir: process.env.PI_CODING_AGENT_DIR,
			tinyfishKey: process.env.TINYFISH_API_KEY,
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
			searchProvider: process.env.PI_WEB_SEARCH_PROVIDER,
			openProvider: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			delete process.env.TINYFISH_API_KEY;
			delete process.env.FIRECRAWL_API_KEY;
			delete process.env.MISTRAL_API_KEY;
			delete process.env.PI_WEB_SEARCH_PROVIDER;
			delete process.env.PI_WEB_OPEN_PROVIDER;

			expect(webProviderOrder()).toEqual(["exa"]);
			expect(openProviderOrder("https://example.com/docs")).toEqual(["exa"]);
			expect(openProviderOrder("mistral-news-article-id")).toEqual([]);
			expect(webStatus().providers.tinyfish).toEqual({ available: false, keyed: false });
			expect(webStatus().providers.firecrawl).toEqual({ available: false, keyed: false });
			expect(webStatus().providers.mistral).toEqual({ available: false, keyed: false });
			expect(webStatus().routes).not.toHaveProperty("pdf");
		} finally {
			restoreEnv("PI_CODING_AGENT_DIR", previous.agentDir);
			restoreEnv("TINYFISH_API_KEY", previous.tinyfishKey);
			restoreEnv("FIRECRAWL_API_KEY", previous.firecrawlKey);
			restoreEnv("MISTRAL_API_KEY", previous.mistralKey);
			restoreEnv("PI_WEB_SEARCH_PROVIDER", previous.searchProvider);
			restoreEnv("PI_WEB_OPEN_PROVIDER", previous.openProvider);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("uses one credential-gated order for web, open, and PDFs", () => {
		const previous = {
			tinyfishKey: process.env.TINYFISH_API_KEY,
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
			searchProvider: process.env.PI_WEB_SEARCH_PROVIDER,
			openProvider: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.TINYFISH_API_KEY = "test-tinyfish";
			process.env.FIRECRAWL_API_KEY = "test-firecrawl";
			process.env.MISTRAL_API_KEY = "test-mistral";
			delete process.env.PI_WEB_SEARCH_PROVIDER;
			delete process.env.PI_WEB_OPEN_PROVIDER;

			const route = ["exa", "tinyfish", "firecrawl", "mistral"];
			expect(webProviderOrder()).toEqual(route);
			expect(openProviderOrder("https://example.com/docs")).toEqual(route);
			expect(openProviderOrder("https://example.com/manual.pdf")).toEqual(route);
		} finally {
			restoreEnv("TINYFISH_API_KEY", previous.tinyfishKey);
			restoreEnv("FIRECRAWL_API_KEY", previous.firecrawlKey);
			restoreEnv("MISTRAL_API_KEY", previous.mistralKey);
			restoreEnv("PI_WEB_SEARCH_PROVIDER", previous.searchProvider);
			restoreEnv("PI_WEB_OPEN_PROVIDER", previous.openProvider);
		}
	});

	test("lets a per-call provider preference take precedence over env overrides", () => {
		const previous = {
			tinyfishKey: process.env.TINYFISH_API_KEY,
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
			searchProvider: process.env.PI_WEB_SEARCH_PROVIDER,
			openProvider: process.env.PI_WEB_OPEN_PROVIDER,
		};
		try {
			process.env.TINYFISH_API_KEY = "test-tinyfish";
			process.env.FIRECRAWL_API_KEY = "test-firecrawl";
			process.env.MISTRAL_API_KEY = "test-mistral";
			process.env.PI_WEB_SEARCH_PROVIDER = "mistral";
			process.env.PI_WEB_OPEN_PROVIDER = "mistral";

			expect(webProviderOrder("tinyfish")).toEqual(["tinyfish", "mistral", "exa", "firecrawl"]);
			expect(webProviderOrder("firecrawl")).toEqual(["firecrawl", "mistral", "exa", "tinyfish"]);
			expect(openProviderOrder("https://example.com/docs", "firecrawl")).toEqual(["firecrawl", "mistral", "exa", "tinyfish"]);
			expect(webProviderOrder("unknown")).toEqual(["mistral", "exa", "tinyfish", "firecrawl"]);
		} finally {
			restoreEnv("TINYFISH_API_KEY", previous.tinyfishKey);
			restoreEnv("FIRECRAWL_API_KEY", previous.firecrawlKey);
			restoreEnv("MISTRAL_API_KEY", previous.mistralKey);
			restoreEnv("PI_WEB_SEARCH_PROVIDER", previous.searchProvider);
			restoreEnv("PI_WEB_OPEN_PROVIDER", previous.openProvider);
		}
	});
});
