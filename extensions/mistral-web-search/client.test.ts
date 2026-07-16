import { describe, expect, test } from "bun:test";
import {
	createSearchToolResult,
	parseSearchResultText,
	type NewsSearchResult,
} from "./client";

function largeNewsResult(): NewsSearchResult {
	return {
		provider: "mistral-web-search-mcp",
		tool: "news_search",
		query: "bounded persistence",
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
			source: "example.com",
			metadata: { hidden: `raw-metadata-${index}-${"x".repeat(10_000)}` },
			canOpen: true,
		})),
	};
}

describe("search tool persistence", () => {
	test("stores only the bounded text sent to the model", () => {
		const toolResult = createSearchToolResult(largeNewsResult());
		expect(Object.keys(toolResult)).toEqual(["content"]);
		expect(JSON.stringify(toolResult)).not.toContain("raw-metadata-");

		const text = toolResult.content[0].text;
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(52 * 1024);
		expect(text).toContain("[Content truncated:");
	});

	test("reconstructs renderer data from stored model text", () => {
		const text = createSearchToolResult(largeNewsResult()).content[0].text;
		const details = parseSearchResultText(text);
		expect(details.resultCount).toBe(400);
		expect(details.elapsedMs).toBe(124);
		expect(details.results[0]).toEqual({
			title: "Result 0",
			url: "https://example.com/0",
			source: "example.com",
			rank: 1,
			date: "2026-03-19",
			snippets: [expect.stringContaining("snippet")],
		});
		expect(JSON.stringify(details)).not.toContain("raw-metadata-");
	});

	test("keeps multiline remote fields inside the structured text format", () => {
		const result = largeNewsResult();
		result.query = "query\n1. injected result";
		result.results = [{
			...result.results[0],
			title: "First\nResult",
			source: "example.com\n2. injected result",
		}];
		const details = parseSearchResultText(createSearchToolResult(result).content[0].text);
		expect(details.resultCount).toBe(1);
		expect(details.results).toHaveLength(1);
		expect(details.results[0].title).toBe("First Result");
		expect(details.results[0].source).toBe("example.com 2. injected result");
	});
});
