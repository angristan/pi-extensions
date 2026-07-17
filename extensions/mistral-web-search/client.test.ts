import { describe, expect, test } from "bun:test";
import {
	createSearchToolResult,
	detectOpenUrlFailure,
	normalizeHttpUrl,
	parseSearchResultText,
	type NewsSearchResult,
} from "./client";

function largeNewsResult(): NewsSearchResult {
	return {
		provider: "mistral-web-search-mcp",
		tool: "news_search",
		query: "bounded persistence",
		startDate: "2026-03-01",
		endDate: "2026-03-31",
		lang: "en",
		limit: 400,
		elapsedMs: 123.6,
		results: Array.from({ length: 400 }, (_, index) => ({
			id: String(index),
			url: `https://example.com/${index}`,
			title: `Result ${index}`,
			description: "description ".repeat(100),
			snippets: ["snippet ".repeat(1_000)],
			date: "2026-03-19",
			rank: index + 1,
			source: "brave",
			metadata: { hidden: `raw-metadata-${index}-${"x".repeat(10_000)}` },
			canOpen: true,
		})),
	};
}

describe("search tool persistence", () => {
	test("stores bounded agent content and display details without raw metadata", () => {
		const toolResult = createSearchToolResult(largeNewsResult());
		expect(Object.keys(toolResult)).toEqual(["content", "details"]);
		expect(JSON.stringify(toolResult)).not.toContain("raw-metadata-");

		const text = toolResult.content[0].text;
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(text).toContain("[Results truncated:");
		expect(text).not.toContain("[Content truncated:");

		expect(toolResult.details).toMatchObject({
			query: "bounded persistence",
			startDate: "2026-03-01",
			endDate: "2026-03-31",
			lang: "en",
			searchEngine: "brave",
			elapsedMs: 124,
			resultCount: 400,
		});
		expect(toolResult.details.results).toHaveLength(10);
		expect(toolResult.details.results[0]).toEqual({
			title: "Result 0",
			url: "https://example.com/0",
			website: "example.com",
			searchEngine: "brave",
			rank: 1,
			date: "2026-03-19",
			description: expect.stringContaining("description"),
			snippets: [expect.stringContaining("snippet")],
			canOpen: undefined,
		});
	});

	test("truncates only between complete result records", () => {
		const text = createSearchToolResult(largeNewsResult()).content[0].text;
		const parsed = parseSearchResultText(text);
		expect(parsed.resultCount).toBe(400);
		expect(parsed.searchEngine).toBe("brave");
		expect(parsed.results.length).toBeGreaterThan(0);
		expect(parsed.results.length).toBeLessThan(400);
		for (const result of parsed.results) {
			expect(result.url).toMatch(/^https:\/\/example\.com\/\d+$/);
			expect(result.website).toBe("example.com");
			expect(result.searchEngine).toBe("brave");
			expect(result.description).toBeUndefined();
			expect(result.snippets).toHaveLength(1);
		}
		expect(text).toMatch(/\[Results truncated: \d+ of 400 result\(s\) shown; remaining results omitted by output limit\.\]$/);
	});

	test("cleans HTML and separates website from search engine", () => {
		const result = largeNewsResult();
		result.results = [{
			...result.results[0],
			url: "https://www.kimi.com/resources/pricing",
			title: "<strong>Kimi K2.6</strong> &amp; API pricing",
			description: "Moonshot&#x27;s <em>official</em> pricing.",
			snippets: ["Costs <strong>$0.95</strong> &amp; scales."],
		}];
		const toolResult = createSearchToolResult(result);
		expect(toolResult.content[0].text).toContain("Kimi K2.6 & API pricing");
		expect(toolResult.content[0].text).toContain("Website: kimi.com");
		expect(toolResult.content[0].text).toContain("Search engine: brave");
		expect(toolResult.content[0].text).not.toContain("Moonshot's official pricing.");
		expect(toolResult.content[0].text).not.toContain("Description:");
		expect(toolResult.content[0].text).toContain("Costs $0.95 & scales.");
		expect(toolResult.content[0].text).not.toMatch(/<\/?(?:strong|em)>|&#x27;|&amp;/);
		expect(toolResult.details.results[0]).toMatchObject({
			title: "Kimi K2.6 & API pricing",
			website: "kimi.com",
			searchEngine: "brave",
			description: "Moonshot's official pricing.",
			snippets: ["Costs $0.95 & scales."],
		});
	});

	test("removes descriptions and deduplicates normalized snippets from agent output", () => {
		const result = largeNewsResult();
		result.results = [{
			...result.results[0],
			description: "Description that should remain UI-only.",
			snippets: [
				"Same <strong>claim</strong>",
				"Same claim",
				"SAME CLAIM",
				"Different claim",
			],
		}];
		const toolResult = createSearchToolResult(result);
		const text = toolResult.content[0].text;
		const parsed = parseSearchResultText(text);
		expect(text).not.toContain("Description:");
		expect(text).not.toContain("Description that should remain UI-only.");
		expect(parsed.results[0]?.snippets).toEqual(["Same claim", "Different claim"]);
		expect(toolResult.details.results[0]?.description).toBe("Description that should remain UI-only.");
		expect(toolResult.details.results[0]?.snippets).toEqual(["Same claim"]);
	});

	test("removes terminal controls and rejects unsafe result URLs", () => {
		const result = largeNewsResult();
		result.query = "pricing\x1b[31m red\x1b[0m";
		result.results = [{
			...result.results[0],
			url: "javascript:alert(1)",
			title: "Safe\x1b]8;;https://evil.example\x07Injected\x1b]8;;\x07 title",
			description: "Control\u0000free",
			snippets: ["Normal \x1b[31mred\x1b[0m text"],
		}];
		const toolResult = createSearchToolResult(result);
		const serialized = JSON.stringify(toolResult);
		expect(serialized).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
		expect(toolResult.content[0].text).toContain("SafeInjected title");
		expect(toolResult.content[0].text).toContain("URL: n/a");
		expect(toolResult.content[0].text).toContain("Normal red text");
		expect(toolResult.details.results[0]?.url).toBeUndefined();
		expect(toolResult.details.results[0]?.website).toBeUndefined();
		expect(normalizeHttpUrl("https://user:pass@example.com/private")).toBeUndefined();
		expect(normalizeHttpUrl("ftp://example.com/file")).toBeUndefined();
		expect(normalizeHttpUrl("https://www.example.com/path")).toBe("https://www.example.com/path");
	});

	test("classifies connector timeout and bot-challenge responses", () => {
		expect(detectOpenUrlFailure("Timed out while opening this page. You may retry once, or try a different source.")).toEqual({
			kind: "failed",
			message: "Timed out while opening this page. You may retry once, or try a different source.",
		});
		expect(detectOpenUrlFailure([
			"title: JavaScript is disabled",
			"# JavaScript is disabled",
			"In order to continue, we need to verify that you're not a robot. This requires JavaScript.",
		].join("\n"))).toEqual({
			kind: "blocked",
			message: "Page requires JavaScript and bot verification.",
		});
		expect(detectOpenUrlFailure("Error: Open blocked: Website denied automated access.")).toEqual({
			kind: "blocked",
			message: "Website denied automated access.",
		});
		expect(detectOpenUrlFailure("Page content loaded normally.")).toBeUndefined();
	});

	test("keeps description available when snippets are absent", () => {
		const result = largeNewsResult();
		result.results = [{
			...result.results[0],
			description: "Fallback evidence from the description.",
			snippets: [],
		}];
		const details = createSearchToolResult(result).details;
		expect(details.results[0]?.description).toBe("Fallback evidence from the description.");
		expect(details.results[0]?.snippets).toEqual([]);
	});

	test("keeps multiline remote fields inside the structured format", () => {
		const result = largeNewsResult();
		result.query = "query\n1. injected result";
		result.results = [{
			...result.results[0],
			title: "First\nResult",
			source: "brave\n2. injected result",
		}];
		const details = parseSearchResultText(createSearchToolResult(result).content[0].text);
		expect(details.resultCount).toBe(1);
		expect(details.results).toHaveLength(1);
		expect(details.results[0].title).toBe("First Result");
		expect(details.results[0].website).toBe("example.com");
		expect(details.results[0].searchEngine).toBe("brave 2. injected result");
	});
});
