import { describe, expect, mock, test } from "bun:test";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchToolResult, type RagResult } from "./client";

class Container {
	render(): string[] {
		return [];
	}
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	...codingAgent,
	keyHint: (_binding: string, description: string) => `Ctrl+O ${description}`,
}));

mock.module("typebox", () => ({
	Type: {
		Array: (items: unknown, options: Record<string, unknown>) => ({ ...options, items }),
		Integer: (options: unknown) => options,
		Object: (shape: unknown) => shape,
		Optional: (value: unknown) => value,
		String: (options: unknown) => options,
		Unsafe: (schema: unknown) => schema,
	},
}));
const testVisibleWidth = (text: string) => text
	.replace(/\x1b\[[0-9;]*m/g, "")
	.replace(/<[^>]+>/g, "")
	.length;

mock.module("@earendil-works/pi-tui", () => ({
	Container,
	hyperlink: (text: string, url: string) => `<link:${url}>${text}</link>`,
	truncateToWidth: (text: string, width: number, suffix = "…") => testVisibleWidth(text) <= width ? text : `${text.slice(0, Math.max(0, width - suffix.length))}${suffix}`,
	visibleWidth: testVisibleWidth,
	wrapTextWithAnsi: (text: string, width: number) => {
		if (testVisibleWidth(text) <= width) return [text];
		const match = /^(<error>)(.*)(<\/error>)$/.exec(text);
		const style = (value: string) => match ? `${match[1]}${value}${match[3]}` : value;
		let remaining = match?.[2] ?? text;
		const lines: string[] = [];
		while (remaining.length > width) {
			const space = remaining.lastIndexOf(" ", width);
			const split = space > 0 ? space : width;
			lines.push(style(remaining.slice(0, split)));
			remaining = remaining.slice(split).trimStart();
		}
		lines.push(style(remaining));
		return lines;
	},
}));
function mockGrepSummary(result: any) {
	const text = result?.content?.find((part: any) => part?.type === "text")?.text ?? "";
	if (/^No matches found/.test(text.trim())) return { matches: 0, files: 0, lowerBound: false };
	const entries = text.split("\n").map((line: string) => line.match(/^(.+):\d+:/)).filter(Boolean) as RegExpMatchArray[];
	const limit = Number.isInteger(result?.details?.matchLimitReached) ? result.details.matchLimitReached : undefined;
	const matches = Math.max(entries.length, limit ?? 0);
	return matches > 0 ? { matches, files: new Set(entries.map((match) => match[1])).size, lowerBound: Boolean(limit) } : undefined;
}
mock.module("../better-native-pi/core.js", () => ({
	fitToolLine: (line: string) => line,
	formatElapsed: (elapsedMs: number) => elapsedMs < 1_000 ? "<1s" : `${Math.round(elapsedMs / 100) / 10}s`,
	formatPlainGrepMatchSummary: (summary: any) => `${summary.matches}${summary.lowerBound ? "+" : ""} matches${summary.files !== undefined ? ` in ${summary.files} files` : ""}`,
	grepMatchSummaryFromResult: mockGrepSummary,
}));
mock.module("../better-native-pi/render.js", () => ({
	BOLD: "<bold>",
	CYAN: "<cyan>",
	DIM: "<dim>",
	GREEN: "<green>",
	MAGENTA: "<magenta>",
	RED: "<red>",
	RESET: "</>",
	nonEmptyLineCount: (text: string) => text.trim().split("\n").filter(Boolean).length,
	shortPath: (path: string) => path,
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
		expect(tools.map((tool) => tool.name)).toEqual(["web_search", "open_url"]);
		const guidelines = [webSearch, openUrl].flatMap((tool) => tool.promptGuidelines ?? []);
		const text = guidelines.join("\n");

		expect(guidelines).toHaveLength(4);
		expect(new Set(guidelines).size).toBe(guidelines.length);
		expect(text.length).toBeLessThanOrEqual(600);
		expect(text).toContain("official or primary sources");
		expect(text).toContain("snippets when sufficient");
		expect(text).toContain("ax URL --md --budget 800");
		expect(text).toContain("public PDFs");
		expect(text).toContain("protocol-level HTTP diagnostics");
		expect(text).toContain("cite URLs");
		expect(text).not.toContain("ax or open_url");
		expect(text).not.toContain("provider unset");
		expect(openUrl.parameters.url.description).not.toContain("returned by web_search");
		expect(Object.keys(webSearch.parameters)).toEqual([
			"query",
			"startDate",
			"endDate",
			"category",
			"includeDomains",
			"excludeDomains",
			"maxAgeHours",
			"limit",
			"provider",
		]);
		expect(webSearch.parameters.category.enum).toContain("news");
		expect(webSearch.parameters.category.enum).not.toContain("github");
		expect(webSearch.parameters.maxAgeHours.minimum).toBe(-1);
		for (const tool of [webSearch, openUrl]) {
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

	test("moves filters to the summary and omits provider preference noise", () => {
		const toolResult = createSearchToolResult({
			provider: "exa",
			tool: "web_search",
			query: "Common Crawl criticism",
			category: "publication",
			includeDomains: ["arxiv.org", "aclanthology.org"],
			maxAgeHours: 24,
			limit: 1,
			elapsedMs: 3_000,
			results: [result(1, "exa")],
		});
		const lines = render(webSearch, toolResult, {
			query: "Common Crawl criticism",
			category: "publication",
			includeDomains: ["arxiv.org", "aclanthology.org"],
			maxAgeHours: 24,
			provider: "exa",
		});
		expect(lines[0]).toContain("Common Crawl criticism");
		expect(lines[0]).not.toContain("publication");
		expect(lines[0]).not.toContain("try Exa first");
		expect(lines[1]).toContain("publication");
		expect(lines[1]).toContain("arxiv.org + aclanthology.org");
		expect(lines[1]).toContain("≤24h old");
		expect(lines[1]).toContain("via Exa");
		expect(lines[1]).toContain("<muted>3s</muted>");
	});

	test("shows titles and clickable full URLs without snippets", () => {
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
		expect(output).toContain("<text>Result 1</text>");
		expect(output).toContain("<link:https://www.example1.com/article><mdLink>https://www.example1.com/article</mdLink></link>");
		expect(output).toContain("<muted>2026-04-21</muted>");
		expect(output).not.toContain("Evidence 1");
	});

	test("renders URL-valued titles once as numbered clickable URLs", () => {
		const item = {
			...result(1, "exa"),
			url: "https://aerospike.com/docs/database/manage/planning/capacity/secondary-indexes/",
			title: "https://aerospike.com/docs/database/manage/planning/capacity/secondary-indexes",
		};
		const toolResult = createSearchToolResult({
			provider: "exa",
			tool: "web_search",
			query: "secondary index capacity",
			limit: 1,
			elapsedMs: 100,
			results: [item],
		});
		const lines = render(webSearch, toolResult, { query: "secondary index capacity" });
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain("<muted>1.</muted> <link:https://aerospike.com/docs/database/manage/planning/capacity/secondary-indexes/>");
		expect(lines[2]).toContain("<muted>2026-04-21</muted>");
		expect(lines.join("\n")).not.toContain("<text>https://aerospike.com");
	});

	test("styles a recognized trailing site name as secondary text", () => {
		const item = {
			...result(1, "exa"),
			url: "https://aclanthology.org/2021.emnlp-main.98/",
			title: "Documenting Large Webtext Corpora - ACL Anthology",
		};
		const toolResult = createSearchToolResult({
			provider: "exa",
			tool: "web_search",
			query: "web corpora",
			limit: 1,
			elapsedMs: 100,
			results: [item],
		});
		const output = render(webSearch, toolResult, { query: "web corpora" }).join("\n");
		expect(output).toContain("<text>Documenting Large Webtext Corpora</text><dim> - ACL Anthology</dim>");
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

	test("expanded shared-engine results avoid repeated source metadata", () => {
		const toolResult = createSearchToolResult({
			provider: "exa",
			tool: "web_search",
			query: "one engine",
			limit: 1,
			elapsedMs: 500,
			results: [result(1, "exa")],
		});
		const output = render(webSearch, toolResult, { query: "one engine" }, { expanded: true }).join("\n");
		expect(output.match(/via Exa/g)).toHaveLength(1);
		expect(output).not.toContain("rank 1");
		expect(output).not.toContain("example1.com ·");
		expect(output).toContain("<dim>↳ </dim><dim>Evidence 1</dim>");
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

	test("wraps long open errors without ellipsizing their message", () => {
		const message = "Open URL failed: exa: Exa HTTP 429: You've hit Exa's free MCP rate limit. To continue using Exa without interruption, add an API key or upgrade your plan.";
		const lines = render(
			openUrl,
			{ content: [{ type: "text", text: message }] },
			{ url: "https://developers.cloudflare.com/queues/configuration/javascript-apis/" },
			{ isError: true, width: 56 },
		);
		const errorLines = lines.slice(1);
		const output = errorLines.join("\n");
		const messageText = errorLines.map((line) => line.replace(/<[^>]+>/g, "").replace(/^ {2}(?:└ |  )/, "")).join(" ");
		expect(errorLines.length).toBeGreaterThan(1);
		expect(messageText).toContain("To continue using Exa without interruption");
		expect(messageText).toContain("upgrade your plan.");
		expect(output).not.toContain("…");
		expect(errorLines.every((line) => line.replace(/<[^>]+>/g, "").length <= 56)).toBe(true);
	});

	test("bot challenges render as blocked rather than opened", () => {
		const toolResult = { content: [{
			type: "text",
			text: "title: JavaScript is disabled\nIn order to continue, verify that you're not a robot. This requires JavaScript.",
		}] };
		expect(render(openUrl, toolResult, { url: "https://guide.example.com/restaurants" }, { isError: true })).toMatchSnapshot();
	});

	test("registers a status command without exposing credential values", () => {
		const agentDirectory = mkdtempSync(join(tmpdir(), "pi-web-status-test-"));
		const previous = {
			agentDirectory: process.env.PI_CODING_AGENT_DIR,
			firecrawlKey: process.env.FIRECRAWL_API_KEY,
			mistralKey: process.env.MISTRAL_API_KEY,
		};
		try {
			process.env.PI_CODING_AGENT_DIR = agentDirectory;
			process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
			process.env.MISTRAL_API_KEY = "test-mistral-key";
			const status = commands.find((entry) => entry.name === "web-status")?.command;
			let message = "";
			status.handler("", { ui: { notify(value: string) { message = value; } } });
			expect(message).toContain("web: exa → firecrawl → mistral");
			expect(message).toContain("open: exa → firecrawl → mistral");
			expect(message).not.toContain("pdf:");
			expect(message).not.toContain("test-firecrawl-key");
			expect(message).not.toContain("test-mistral-key");
		} finally {
			if (previous.agentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agentDirectory;
			if (previous.firecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = previous.firecrawlKey;
			if (previous.mistralKey === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = previous.mistralKey;
			rmSync(agentDirectory, { recursive: true, force: true });
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
