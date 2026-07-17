import { expect, test } from "bun:test";
import contextInspector, { analyzeContext, sanitizeTerminalText } from "./index";

function makeContext() {
	const user = { id: "u", type: "message", message: { role: "user", content: [{ type: "text", text: "hello user" }] } };
	const assistant = {
		id: "a",
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning text" },
				{ type: "text", text: "answer text" },
				{ type: "toolCall", name: "read", arguments: { path: "\x1b[31msrc/file.ts\x1b[0m" } },
			],
			usage: { input: 12, cacheRead: 20, cacheWrite: 3 },
		},
	};
	const hidden = { id: "c", type: "custom_message", customType: "hidden", display: false, content: "context note" };
	const compacted = { id: "old", type: "message", message: { role: "user", content: "older branch text" } };
	const inactive = { id: "other", type: "message", message: { role: "assistant", content: "inactive branch" } };
	return {
		model: { contextWindow: 2_000 },
		getSystemPrompt: () => "12345678",
		getSystemPromptOptions: () => ({ contextFiles: [{ path: "\x1b[32mAGENTS.md\x1b[0m" }], skills: [{ name: "review" }], activeTools: ["read"] }),
		getContextUsage: () => ({ tokens: 500, contextWindow: 2_000 }),
		sessionManager: {
			buildContextEntries: () => [user, assistant, hidden],
			getBranch: () => [compacted, user, assistant, hidden],
			getEntries: () => [compacted, user, assistant, hidden, inactive],
		},
	};
}

test("accounts for active, compacted, and inactive context separately", () => {
	const analysis = analyzeContext(makeContext());
	const ids = analysis.categories.map((category) => category.id);

	expect(analysis.systemTokens).toBe(2);
	expect(ids).toEqual(expect.arrayContaining(["user", "reasoning", "answers", "tool-calls", "custom"]));
	expect(analysis.compactedAwayEntries).toBe(1);
	expect(analysis.inactiveTreeEntries).toBe(1);
	expect(analysis.customHiddenEntries).toBe(1);
	expect(analysis.latestCacheRead).toBe(20);
	expect(analysis.contextFiles).toEqual(["AGENTS.md"]);
	expect(analysis.largest.find((entry) => entry.path)?.path).toBe("src/file.ts");
});

test("strips terminal controls and gives non-TUI users a compact summary", async () => {
	expect(sanitizeTerminalText("safe\x1b[31m red\x1b[0m\ttext\x07")).toBe("safe red    text");
	let command: any;
	contextInspector({
		registerCommand: (_name: string, options: any) => { command = options; },
		getActiveTools: () => ["read", "write"],
	} as any);
	const notices: string[] = [];
	await command.handler("", { ...makeContext(), mode: "json", ui: { notify: (message: string) => notices.push(message) } });
	expect(notices[0]).toContain("Estimated context:");
	expect(notices[0]).toContain("provider reports 500");
});
