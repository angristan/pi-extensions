import { describe, expect, spyOn, test } from "bun:test";
import { parseExaSearchText, searchExaWeb } from "./providers/exa";
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
