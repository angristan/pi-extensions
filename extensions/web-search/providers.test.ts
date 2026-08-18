import { describe, expect, spyOn, test } from "bun:test";
import { WebProviderError } from "./provider-error";
import { parseExaAdvancedSearchText, parseExaSearchText, searchExaWeb } from "./providers/exa";
import { dateFilter, parseFirecrawlItems } from "./providers/firecrawl";

describe("provider normalization", () => {
	test("deduplicates Exa tracking variants and preserves evidence", () => {
		const results = parseExaSearchText([
			"Title: OpenCode\nURL: https://github.com/anomalyco/opencode?referrer=test\nPublished: 2026-07-17\nHighlights:\nPrimary result.",
			"---",
			"Title: Duplicate\nURL: https://github.com/anomalyco/opencode?via=other\nPublished: 2026-07-16\nHighlights:\nDuplicate result.",
			"---",
			"Title: Docs\nURL: https://opencode.ai/docs/\nPublished: N/A\nHighlights:\nOfficial docs.",
		].join("\n"));

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			url: "https://github.com/anomalyco/opencode",
			title: "OpenCode",
			date: "2026-07-17",
			snippets: ["Primary result."],
			source: "exa",
			rank: 1,
		});
		expect(results[1]?.rank).toBe(2);
	});

	test("parses advanced highlights without retaining full page text", () => {
		const results = parseExaAdvancedSearchText(JSON.stringify({
			results: [{
				id: "https://example.com/docs",
				url: "https://example.com/docs",
				title: "Docs",
				publishedDate: "2026-08-18T00:00:00.000Z",
				text: "full page text must not enter context",
				highlights: ["Grounded source evidence."],
			}],
		}));
		expect(results[0]).toMatchObject({
			url: "https://example.com/docs",
			title: "Docs",
			date: "2026-08-18T00:00:00.000Z",
			snippets: ["Grounded source evidence."],
		});
		expect(JSON.stringify(results)).not.toContain("full page text");
	});

	test("uses advanced Exa search for native filters with unbounded highlights", async () => {
		const previousFetch = globalThis.fetch;
		let requestUrl = "";
		let requestBody: any;
		globalThis.fetch = (async (input, init) => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				result: { content: [{ type: "text", text: JSON.stringify({ results: [{
					url: "https://reuters.com/article",
					title: "Article",
					publishedDate: "2026-08-18",
					text: "discarded full text",
					highlights: ["Source highlight."],
				}] }) }] },
			}), { headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		try {
			const result = await searchExaWeb({
				query: "AI policy announcement",
				startDate: "2026-08-01",
				endDate: "2026-08-18",
				category: "news",
				includeDomains: [" reuters.com "],
				excludeDomains: ["example.com"],
				maxAgeHours: 0,
				limit: 5,
			});
			expect(new URL(requestUrl).searchParams.get("tools")).toBe("web_search_advanced_exa");
			expect(requestUrl).not.toContain("exaApiKey");
			expect(requestBody.params.name).toBe("web_search_advanced_exa");
			expect(requestBody.params.arguments).toMatchObject({
				query: "AI policy announcement",
				numResults: 5,
				type: "auto",
				category: "news",
				includeDomains: ["reuters.com"],
				excludeDomains: ["example.com"],
				startPublishedDate: "2026-08-01T00:00:00.000Z",
				endPublishedDate: "2026-08-19T00:00:00.000Z",
				maxAgeHours: 0,
				textMaxCharacters: 2_000,
				enableHighlights: true,
				highlightsQuery: "AI policy announcement",
			});
			expect(requestBody.params.arguments).not.toHaveProperty("enableSummary");
			expect(requestBody.params.arguments).not.toHaveProperty("highlightsMaxCharacters");
			expect(result.results[0]?.snippets).toEqual(["Source highlight."]);
			expect(JSON.stringify(result)).not.toContain("discarded full text");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	test("defers unsupported company filters to local enforcement", async () => {
		const previousFetch = globalThis.fetch;
		let requestArguments: Record<string, unknown> = {};
		globalThis.fetch = (async (_input, init) => {
			requestArguments = JSON.parse(String(init?.body)).params.arguments;
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
			}), { headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		try {
			await searchExaWeb({
				query: "European AI companies",
				category: "company",
				startDate: "2026-01-01",
				excludeDomains: ["linkedin.com"],
			});
			expect(requestArguments.category).toBe("company");
			expect(requestArguments).not.toHaveProperty("startPublishedDate");
			expect(requestArguments).not.toHaveProperty("excludeDomains");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	test("prioritizes explicit domains over the incompatible publication vertical", async () => {
		const previousFetch = globalThis.fetch;
		let requestArguments: Record<string, unknown> = {};
		globalThis.fetch = (async (_input, init) => {
			requestArguments = JSON.parse(String(init?.body)).params.arguments;
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
			}), { headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		try {
			await searchExaWeb({
				query: "dataset limitations",
				category: "publication",
				includeDomains: ["arxiv.org", "aclanthology.org"],
				maxAgeHours: 24,
			});
			expect(requestArguments.query).toBe("Scholarly publication about dataset limitations");
			expect(requestArguments.includeDomains).toEqual(["arxiv.org", "aclanthology.org"]);
			expect(requestArguments).not.toHaveProperty("category");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	test("sends configured Exa credentials only in the request header", async () => {
		const previousFetch = globalThis.fetch;
		const previousApiKey = process.env.EXA_API_KEY;
		let requestUrl = "";
		let requestApiKey: string | null = null;
		globalThis.fetch = (async (input, init) => {
			requestUrl = String(input);
			requestApiKey = new Headers(init?.headers).get("x-api-key");
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				result: { content: [{ type: "text", text: "Title: Docs\nURL: https://example.com/docs\nHighlights:\nOfficial docs." }] },
			}), { headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		try {
			process.env.EXA_API_KEY = "test-exa-key";
			await searchExaWeb({ query: "credential transport" });
			expect(requestUrl).toBe("https://mcp.exa.ai/mcp");
			expect(requestUrl).not.toContain("test-exa-key");
			expect(requestApiKey).toBe("test-exa-key");
		} finally {
			globalThis.fetch = previousFetch;
			if (previousApiKey === undefined) delete process.env.EXA_API_KEY;
			else process.env.EXA_API_KEY = previousApiKey;
		}
	});

	test("throws MCP tool error results instead of treating them as empty success", async () => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({
			jsonrpc: "2.0",
			result: {
				content: [{ type: "text", text: "web_search_exa error (400): invalid filter" }],
				isError: true,
			},
		}), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
		try {
			let caught: unknown;
			try {
				await searchExaWeb({ query: "invalid request" });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(WebProviderError);
			expect(caught).toMatchObject({ status: 400, retriable: false });
			expect((caught as Error).message).toContain("invalid filter");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	test("retries Exa rate limits six times before succeeding", async () => {
		const previousFetch = globalThis.fetch;
		const random = spyOn(Math, "random").mockReturnValue(0);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls < 7) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				result: { content: [{ type: "text", text: "Title: Docs\nURL: https://example.com/docs\nHighlights:\nFound after retry." }] },
			}), { headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;
		try {
			const result = await searchExaWeb({ query: "retry test" });
			expect(calls).toBe(7);
			expect(result.results[0]).toMatchObject({ url: "https://example.com/docs", title: "Docs" });
		} finally {
			globalThis.fetch = previousFetch;
			random.mockRestore();
		}
	});

	test("surfaces an Exa rate limit after seven attempts", async () => {
		const previousFetch = globalThis.fetch;
		const random = spyOn(Math, "random").mockReturnValue(0);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("still rate limited", { status: 429, headers: { "Retry-After": "0" } });
		}) as typeof fetch;
		try {
			await expect(searchExaWeb({ query: "retry test" })).rejects.toThrow("Exa HTTP 429");
			expect(calls).toBe(7);
		} finally {
			globalThis.fetch = previousFetch;
			random.mockRestore();
		}
	});

	test("falls back immediately when Retry-After exceeds the retry budget", async () => {
		const previousFetch = globalThis.fetch;
		const random = spyOn(Math, "random").mockReturnValue(0);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			return new Response("long rate limit", { status: 429, headers: { "Retry-After": "300" } });
		}) as typeof fetch;
		try {
			await expect(searchExaWeb({ query: "retry test" })).rejects.toThrow("Exa HTTP 429");
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = previousFetch;
			random.mockRestore();
		}
	});

	test("normalizes Firecrawl web and news records", () => {
		const results = parseFirecrawlItems([
			{ url: "https://example.com/a", title: "A", description: "Web description" },
			{ url: "https://example.com/b", title: "B", snippet: "News snippet", date: "1 day ago" },
			{ url: "javascript:alert(1)", title: "Unsafe" },
		]);

		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ description: "Web description", snippets: ["Web description"], rank: 1 });
		expect(results[1]).toMatchObject({ description: "News snippet", snippets: ["News snippet"], date: "1 day ago", rank: 2 });
	});

	test("uses exact custom web-search dates", () => {
		expect(dateFilter("2026-06-17")).toBe("cdr:1,cd_min:06/17/2026");
		expect(dateFilter(undefined, "2026-07-17")).toBe("cdr:1,cd_max:07/17/2026");
	});
});
