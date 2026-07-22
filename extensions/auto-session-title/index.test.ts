import { describe, expect, test } from "bun:test";
import { requestTitleCompletion } from "./request";

describe("auto-session-title model requests", () => {
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
