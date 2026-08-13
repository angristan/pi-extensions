import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTitleModelConfig, normalizeTitle, TITLE_SYSTEM_PROMPT, titleModelConfigPath } from "./index";
import { requestTitleCompletion } from "./request";

describe("auto-session-title model requests", () => {
	test("titles the durable project instead of its latest component", () => {
		expect(TITLE_SYSTEM_PROMPT).toContain("A component remains subordinate even when discussed for several turns");
		expect(TITLE_SYSTEM_PROMPT).toContain("title that complete durable focus at the same scope");
		expect(TITLE_SYSTEM_PROMPT).toContain("Never preserve it when it names only a component of focus_summary");
		expect(TITLE_SYSTEM_PROMPT).toContain('A session building Meridian Sync remains "Meridian Sync" while discussing its revision DAG, RPC layer, and notification WebSockets');
	});

	test("rejects generated filesystem path titles", () => {
		const path = "/var/folders/sp/fywhcyx14lq17414yv54gyqh0000gn/T/pi-clipboard-1a6dda4b-2944-4d05-9635-7b7194354361.png";
		expect(normalizeTitle(path)).toBeUndefined();
		expect(normalizeTitle(`Screenshot ${path}`)).toBeUndefined();
		expect(normalizeTitle("~/Desktop/screenshot.png")).toBeUndefined();
		expect(normalizeTitle("src/session-title.ts")).toBeUndefined();
		expect(normalizeTitle("Pi Tab Title")).toBe("Pi Tab Title");
	});

	test("reads model config from the configured Pi agent directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-test-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = directory;
			writeFileSync(join(directory, "auto-session-title.json"), JSON.stringify({
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				thinkingLevel: "xhigh",
			}));

			expect(titleModelConfigPath()).toBe(join(directory, "auto-session-title.json"));
			expect(loadTitleModelConfig()).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "xhigh" });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("routes Codex Luna through Pi's provider-aware completion API", async () => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
		};
		const auth = {
			apiKey: "test-token",
			headers: { "x-test": "header" },
			env: { TEST_ENV: "value" },
		};
		let invocation: any[] | undefined;
		const response = await requestTitleCompletion(
			async (...args: any[]) => {
				invocation = args;
				return {
					content: [{ type: "text", text: '{"title":"Luna Session Titles"}' }],
					stopReason: "stop",
				};
			},
			model,
			auth,
			"title system prompt",
			"title context",
			"session-1",
			new AbortController().signal,
			"xhigh",
		);

		expect(response).toBe('{"title":"Luna Session Titles"}');
		expect(invocation?.[0]).toBe(model);
		expect(invocation?.[1]).toMatchObject({
			systemPrompt: "title system prompt",
			messages: [{ role: "user", content: [{ type: "text", text: "title context" }] }],
		});
		expect(invocation?.[2]).toMatchObject({
			apiKey: "test-token",
			headers: { "x-test": "header" },
			env: { TEST_ENV: "value" },
			maxTokens: 384,
			reasoning: "xhigh",
			sessionId: "session-1:title",
		});
	});
});
