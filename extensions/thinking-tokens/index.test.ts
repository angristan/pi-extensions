import { describe, expect, test } from "bun:test";
import thinkingTokens, {
	estimateThinkingTokens,
	exactReasoningTokens,
	formatLabel,
	formatTokenCount,
} from "./index";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	labels: Array<string | undefined>;
	ctx: any;
}

function setup(): Harness {
	const handlers = new Map<string, Handler>();
	const labels: Array<string | undefined> = [];
	const ctx = {
		mode: "tui",
		ui: {
			setHiddenThinkingLabel: (label?: string) => labels.push(label),
		},
	};
	thinkingTokens({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as any, {
		pushLabel: (_context, label) => labels.push(label),
	});
	return { handlers, labels, ctx };
}

/** Drive a streaming episode: thinking deltas then a finalized message. */
function streamThinking(
	handlers: Map<string, Handler>,
	ctx: any,
	thinking: string,
	usage?: Record<string, number>,
) {
	const partial = { role: "assistant", content: [{ type: "thinking", thinking }] };
	handlers.get("message_update")?.({ message: partial, assistantMessageEvent: { type: "thinking_delta", delta: thinking } }, ctx);
	handlers.get("message_end")?.({
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking }],
			usage: usage ? { reasoning: usage.reasoning } : undefined,
		},
	}, ctx);
}

describe("token accounting", () => {
	test("estimates from thinking text length", () => {
		expect(estimateThinkingTokens({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "abcd" }, // 4 chars -> 1 token
				{ type: "text", text: "answer" }, // not thinking
				{ type: "thinking", thinking: "efghij" }, // 6 chars -> 2 tokens
			],
		} as any)).toBe(3);
	});

	test("reads exact reasoning tokens from usage when the provider reports them", () => {
		expect(exactReasoningTokens({ role: "assistant", content: [], usage: { reasoning: 1234 } } as any)).toBe(1234);
		expect(exactReasoningTokens({ role: "assistant", content: [], usage: { reasoning: 0 } } as any)).toBe(0);
		expect(exactReasoningTokens({ role: "assistant", content: [], usage: {} } as any)).toBeUndefined();
		expect(exactReasoningTokens({ role: "assistant", content: [] } as any)).toBeUndefined();
	});

	test("formats compact token counts", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(512)).toBe("512");
		expect(formatTokenCount(1234)).toBe("1.23k");
		expect(formatTokenCount(123_456)).toBe("123k");
		expect(formatTokenCount(2_500_000)).toBe("2.5M");
	});

	test("labels streaming and frozen states differently", () => {
		expect(formatLabel(0, true)).toBe("Thinking\u2026");
		expect(formatLabel(1200, true)).toBe("Thinking\u2026 1.2k");
		expect(formatLabel(1200, false)).toBe("Thinking... 1.2k");
	});
});

describe("label lifecycle", () => {
	test("updates live from streamed thinking and freezes the exact count", () => {
		const { handlers, labels, ctx } = setup();

		handlers.get("agent_start")?.({}, ctx);
		streamThinking(handlers, ctx, "a".repeat(400), { reasoning: 1234 });

		expect(labels).toEqual(["Thinking\u2026 100", "Thinking... 1.23k"]);
	});

	test("keeps the streamed estimate when the provider does not report reasoning tokens", () => {
		const { handlers, labels, ctx } = setup();

		handlers.get("agent_start")?.({}, ctx);
		streamThinking(handlers, ctx, "a".repeat(400));

		expect(labels.at(-1)).toBe("Thinking... 100");
	});

	test("never emits labels for messages without thinking", () => {
		const { handlers, labels, ctx } = setup();

		handlers.get("agent_start")?.({}, ctx);
		handlers.get("message_update")?.({
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		}, ctx);
		handlers.get("message_end")?.({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, ctx);
		handlers.get("message_end")?.({ message: { role: "toolResult", content: [] } }, ctx);

		expect(labels).toEqual([]);
	});

	test("a new run clears the previous episode's frozen count", () => {
		const { handlers, labels, ctx } = setup();

		handlers.get("agent_start")?.({}, ctx);
		streamThinking(handlers, ctx, "a".repeat(400), { reasoning: 1234 });
		handlers.get("agent_settled")?.({}, ctx);
		handlers.get("agent_start")?.({}, ctx);

		expect(labels.at(-1)).toBeUndefined();
	});

	test("restores Pi's default label on shutdown", () => {
		const { handlers, labels, ctx } = setup();

		handlers.get("session_shutdown")?.({}, ctx);

		expect(labels).toEqual([undefined]);
	});
});
