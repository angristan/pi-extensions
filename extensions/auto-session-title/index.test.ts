import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTitleModelConfig, titleModelConfigPath } from "./index";
import { requestTitleCompletion } from "./request";

describe("auto-session-title model requests", () => {
	test("reads model config from the configured Pi agent directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-test-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = directory;
			writeFileSync(join(directory, "auto-session-title.json"), JSON.stringify({
				provider: "openai-codex",
				model: "gpt-5.6-luna",
			}));

			expect(titleModelConfigPath()).toBe(join(directory, "auto-session-title.json"));
			expect(loadTitleModelConfig()).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna" });
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
			reasoning: "minimal",
			sessionId: "session-1:title",
		});
	});
});
