import { expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import sideChat, { buildSidePrompt } from "./index";

initTheme("dark", false);

test("wraps the inherited conversation and explicit question separately", () => {
	const result = buildSidePrompt("user: main task\nassistant: working", "  What changed?  ", 100_000);
	expect(result.truncated).toBe(false);
	expect(result.prompt).toContain("<inherited_conversation>\nuser: main task");
	expect(result.prompt).toContain("<side_question>\nWhat changed?\n</side_question>");
});

test("bounds oversized inherited context while retaining its head and recent tail", () => {
	const conversation = `HEAD-${"a".repeat(90_000)}-TAIL`;
	const result = buildSidePrompt(conversation, "summarize", 1_000);

	expect(result.truncated).toBe(true);
	expect(result.prompt).toContain("HEAD-");
	expect(result.prompt).toContain("-TAIL");
	expect(result.prompt).toContain("inherited conversation omitted for the bounded side request");
	expect(result.prompt.length).toBeLessThan(conversation.length);
});

test("uses the model registry and honors message output padding", async () => {
	const commands = new Map<string, any>();
	const renderers = new Map<string, any>();
	const completionCalls: any[][] = [];
	let customCalls = 0;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerEntryRenderer() {},
		registerMessageRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
		appendEntry() {},
		sendMessage() {},
		on() {},
	};
	const ctx = {
		mode: "tui",
		model: { provider: "test", id: "side-model", name: "Side model", contextWindow: 128_000 },
		modelRegistry: {
			complete: async (...args: any[]) => {
				completionCalls.push(args);
				return { content: [{ type: "text", text: "Registry-backed answer" }], stopReason: "stop" };
			},
		},
		getSystemPrompt: () => "System prompt",
		sessionManager: {
			buildSessionContext: () => ({ messages: [] }),
			getSessionId: () => "side-session",
		},
		ui: {
			theme,
			notify() {},
			select: async () => "Dismiss",
			custom: async (factory: any) => {
				customCalls += 1;
				if (customCalls > 1) return undefined;
				return new Promise((resolve) => {
					factory({ requestRender() {} }, theme, {}, resolve);
				});
			},
		},
	};

	sideChat(pi as any);
	await commands.get("side").handler("What changed?", ctx);

	expect(completionCalls).toHaveLength(1);
	expect(completionCalls[0]?.[0]).toBe(ctx.model);
	expect(completionCalls[0]?.[2]).toMatchObject({ reasoning: "low", sessionId: "side-session:side" });

	const rendered = renderers.get("side-promoted")(
		{ content: "Saved answer" },
		{ outputPad: 3 },
		theme,
	).render(40);
	expect(rendered[0]).toStartWith("   ");
});
