import { describe, expect, mock, test } from "bun:test";
import { createSearchToolResult, type RagResult } from "./client";

class Container {
	render(): string[] {
		return [];
	}
}

mock.module("typebox", () => ({
	Type: {
		Integer: (options: unknown) => options,
		Object: (shape: unknown) => shape,
		Optional: (value: unknown) => value,
		String: (options: unknown) => options,
	},
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container,
	hyperlink: (text: string, url: string) => `<link:${url}>${text}</link>`,
	truncateToWidth: (text: string, width: number, suffix = "…") => text.length <= width ? text : `${text.slice(0, Math.max(0, width - suffix.length))}${suffix}`,
	visibleWidth: (text: string) => text.replace(/<[^>]+>/g, "").length,
}));
mock.module("../better-native-pi/core.js", () => ({
	fitToolLine: (line: string) => line,
	formatElapsed: (elapsedMs: number) => elapsedMs < 1_000 ? "<1s" : `${Math.round(elapsedMs / 100) / 10}s`,
}));
mock.module("../better-native-pi/render.js", () => ({
	BOLD: "<bold>",
	GREEN: "<green>",
	MAGENTA: "<magenta>",
	RED: "<red>",
	RESET: "</>",
}));

const { default: webSearchExtension } = await import("./index");

const tools: any[] = [];
const commands: any[] = [];
webSearchExtension({
	registerTool(tool: any) {
		tools.push(tool);
	},
	registerCommand(name: string, command: any) {
		commands.push({ name, command });
	},
	on() {},
	getActiveTools() {
		return [];
	},
	setActiveTools() {},
} as any);

const webSearch = tools.find((tool) => tool.name === "web_search");
const newsSearch = tools.find((tool) => tool.name === "news_search");
const openUrl = tools.find((tool) => tool.name === "open_url");
const theme = {
	fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
};

function result(index: number, source = "brave"): RagResult {
	return {
		id: String(index),
		url: `https://www.example${index}.com/article`,
		title: `Result ${index}`,
		description: `Description ${index}`,
		snippets: [`Evidence ${index}`],
		date: "2026-04-21",
		rank: index,
		source,
		metadata: null,
		canOpen: true,
	};
}

function render(tool: any, toolResult: unknown, args: Record<string, unknown>, options: { expanded?: boolean; isError?: boolean; width?: number } = {}): string[] {
	const component = tool.renderResult(
		toolResult,
		{ expanded: options.expanded ?? false, isPartial: false },
		theme,
		{ args, isError: options.isError ?? false },
	);
	return component.render(options.width ?? 1_000);
}

describe("web tool prompt guidance", () => {
	test("stays concise without dropping routing and evidence behavior", () => {
		const guidelines = [webSearch, newsSearch, openUrl].flatMap((tool) => tool.promptGuidelines ?? []);
		const text = guidelines.join("\n");

		expect(guidelines).toHaveLength(5);
		expect(new Set(guidelines).size).toBe(guidelines.length);
		expect(text.length).toBeLessThanOrEqual(600);
		expect(text).toContain("official or primary sources");
		expect(text).toContain("recent events");
		expect(text).toContain("local content retrieval");
		expect(text).toContain("protocol-level HTTP diagnostics");
		expect(text).toContain("cite the URLs used");
		expect(text).not.toContain("provider unset");
		for (const tool of [webSearch, newsSearch, openUrl]) {
			expect(tool.parameters.provider.description).toContain("Leave unset unless a provider-specific retry is needed");
		}
	});
});

describe("web search renderer", () => {
	test("collapsed results use shared engine attribution and semantic colors", () => {
		const toolResult = createSearchToolResult({
			provider: "mistral",
			tool: "web_search",
			query: "Kimi pricing",
			startDate: "2026-04-01",
			endDate: "2026-04-30",
			limit: 6,
			elapsedMs: 1_198,
			results: Array.from({ length: 6 }, (_, index) => result(index + 1)),
		});
		expect(render(webSearch, toolResult, { query: "Kimi pricing", startDate: "2026-04-01", endDate: "2026-04-30" })).toMatchSnapshot();
	});

	test("shows clickable full URLs without titles, domains, or snippets", () => {
		const toolResult = createSearchToolResult({
			provider: "exa",
			tool: "web_search",
			query: "static sites",
			limit: 1,
			elapsedMs: 100,
			results: [result(1, "exa")],
		});
		const output = render(webSearch, toolResult, { query: "static sites" }).join("\n");
		expect(output).toContain("<dim>“</dim><accent>static sites</accent><dim>”</dim>");
		expect(output).toContain("<link:https://www.example1.com/article><text>https://www.example1.com/article</text></link>");
		expect(output).toContain("<muted>2026-04-21</muted>");
		expect(output).not.toContain("Result 1");
		expect(output).not.toContain("<accent>example1.com</accent>");
		expect(output).not.toContain("Evidence 1");
	});

	test("compacts timestamps and omits unavailable dates", () => {
		const toolResult = {
			content: [{ type: "text", text: "stored" }],
			details: {
				provider: "exa",
				resultCount: 2,
				results: [
					{ title: "Dated", url: "https://example.com/dated", date: "2026-07-06T13:00:00.000Z", snippets: [] },
					{ title: "Undated", url: "https://example.com/undated", date: "N/A", snippets: [] },
				],
			},
		};
		const lines = render(webSearch, toolResult, { query: "dates" }, { expanded: true });
		expect(lines.join("\n")).toContain("2026-07-06");
		expect(lines.join("\n")).not.toContain("T13:00:00.000Z");
		expect(lines.join("\n")).not.toContain("N/A");
	});

	test("shows fallback provider trails and credits", () => {
		const toolResult = createSearchToolResult({
			provider: "firecrawl",
			tool: "web_search",
			query: "fallback",
			limit: 1,
			elapsedMs: 750,
			creditsUsed: 2,
			attempts: [
				{ provider: "exa", status: "failed", elapsedMs: 200, error: "rate limited" },
				{ provider: "firecrawl", status: "success", elapsedMs: 550, resultCount: 1, creditsUsed: 2 },
			],
			results: [result(1, "firecrawl")],
		});
		const lines = render(webSearch, toolResult, { query: "fallback" });
		expect(lines[1]).toContain("via Exa → Firecrawl");
		expect(lines[1]).toContain("2 credits");
	});

	test("expanded mixed-engine results retain per-result attribution", () => {
		const toolResult = createSearchToolResult({
			provider: "mistral",
			tool: "web_search",
			query: "mixed sources",
			limit: 2,
			elapsedMs: 500,
			results: [result(1, "brave"), result(2, "bing")],
		});
		expect(render(webSearch, toolResult, { query: "mixed sources" }, { expanded: true })).toMatchSnapshot();
	});

	test("empty results remain distinct from failures", () => {
		const toolResult = createSearchToolResult({
			provider: "mistral",
			tool: "web_search",
			query: "no matches",
			limit: 5,
			elapsedMs: 250,
			results: [],
		});
		expect(render(webSearch, toolResult, { query: "no matches" })).toMatchSnapshot();
	});

	test("search failures show sanitized reasons", () => {
		const toolResult = { content: [{ type: "text", text: "Request \x1b[31mtimed out\x1b[0m after 10s" }] };
		expect(render(webSearch, toolResult, { query: "pricing\x1b]8;;https://evil.example\x07query\x1b]8;;\x07" }, { isError: true })).toMatchSnapshot();
	});

	test("open failures use the requested target and actual reason", () => {
		const toolResult = { content: [{ type: "text", text: "Timed out while opening this page. Try another source." }] };
		expect(render(openUrl, toolResult, { url: "https://example.com/docs" }, { isError: true })).toMatchSnapshot();
	});

	test("bot challenges render as blocked rather than opened", () => {
		const toolResult = { content: [{
			type: "text",
			text: "title: JavaScript is disabled\nIn order to continue, verify that you're not a robot. This requires JavaScript.",
		}] };
		expect(render(openUrl, toolResult, { url: "https://guide.example.com/restaurants" }, { isError: true })).toMatchSnapshot();
	});

	test("registers a status command without exposing credential values", () => {
		const previous = {
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
		};
		try {
			process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
			process.env.MISTRAL_API_KEY = "test-mistral-key";
			const status = commands.find((entry) => entry.name === "web-status")?.command;
			let message = "";
			status.handler("", { ui: { notify(value: string) { message = value; } } });
			expect(message).toContain("web: exa → firecrawl → mistral");
			expect(message).toContain("news: exa → firecrawl → mistral");
			expect(message).toContain("open: exa → firecrawl → mistral");
			expect(message).not.toContain("pdf:");
			expect(message).not.toContain("test-firecrawl-key");
			expect(message).not.toContain("test-mistral-key");
		} finally {
			if (previous.firecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = previous.firecrawlKey;
			if (previous.mistralKey === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = previous.mistralKey;
		}
	});

	test("open summaries format byte counts for humans", () => {
		const toolResult = {
			content: [{ type: "text", text: "stored content" }],
			details: {
				url: "https://example.com/article",
				provider: "exa",
				elapsedMs: 271,
				truncated: false,
				originalBytes: 15_309,
				originalLines: 112,
				content: "Readable content",
			},
		};
		const lines = render(openUrl, toolResult, { url: "https://example.com/article" });
		expect(lines.join("\n")).toContain("112 lines · 15.3 KB");
		expect(lines.join("\n")).not.toContain("15309b");
	});

	test("expanded open content strips terminal controls", () => {
		const toolResult = {
			content: [{ type: "text", text: "stored content" }],
			details: {
				url: "https://example.com/docs",
				elapsedMs: 250,
				truncated: false,
				originalBytes: 32,
				originalLines: 1,
				content: "Readable \x1b[31mred\x1b[0m content",
			},
		};
		expect(render(openUrl, toolResult, { url: "https://example.com/docs" }, { expanded: true })).toMatchSnapshot();
	});
});
