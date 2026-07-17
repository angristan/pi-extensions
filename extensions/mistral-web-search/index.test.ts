/**
 * Dependency graph:
 * Direct: `./client`, `./index`, `bun:test`.
 * Used by: `Bun test runner`.
 */
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
	visibleWidth: (text: string) => text.length,
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
webSearchExtension({
	registerTool(tool: any) {
		tools.push(tool);
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

function render(tool: any, toolResult: unknown, args: Record<string, unknown>, options: { expanded?: boolean; isError?: boolean } = {}): string[] {
	const component = tool.renderResult(
		toolResult,
		{ expanded: options.expanded ?? false, isPartial: false },
		theme,
		{ args, isError: options.isError ?? false },
	);
	return component.render(1_000);
}

describe("mistral web search renderer", () => {
	test("collapsed results use shared engine attribution and semantic colors", () => {
		const toolResult = createSearchToolResult({
			provider: "mistral-web-search-mcp",
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

	test("expanded mixed-engine results retain per-result attribution", () => {
		const toolResult = createSearchToolResult({
			provider: "mistral-web-search-mcp",
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
			provider: "mistral-web-search-mcp",
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
