import { describe, expect, test } from "bun:test";
import { parseExaSearchText } from "./providers/exa";
import { dateFilter, newsDateFilter, parseFirecrawlItems } from "./providers/firecrawl";

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

	test("uses exact custom news dates and a rolling-week default", () => {
		expect(newsDateFilter("2026-06-17", "2026-07-17")).toBe("cdr:1,cd_min:06/17/2026,cd_max:07/17/2026");
		expect(dateFilter("2026-06-17")).toBe("cdr:1,cd_min:06/17/2026");
		expect(dateFilter(undefined, "2026-07-17")).toBe("cdr:1,cd_max:07/17/2026");
		expect(newsDateFilter()).toBe("qdr:w");
	});
});
