import { describe, expect, test } from "bun:test";
import thinkingTokens, {
	estimateThinkingTokens,
	exactReasoningTokens,
	formatTokenCount,
	formatWidgetLine,
	THINKING_TOKENS_EVENT,
	type ThinkingEpisodeEvent,
} from "./index";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	widgets: Array<string | undefined>;
	emitted: Array<{ channel: string; data: ThinkingEpisodeEvent }>;
	ctx: any;
	ticks: Array<() => void>;
}

function setup(): Harness {
	const handlers = new Map<string, Handler>();
	const widgets: Array<string | undefined> = [];
	const emitted: Array<{ channel: string; data: ThinkingEpisodeEvent }> = [];
	const ticks: Array<() => void> = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			setWidget: (_key: string, content: string[] | undefined) => widgets.push(content?.[0]),
		},
	};
	thinkingTokens({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		events: { emit: (channel: string, data: ThinkingEpisodeEvent) => emitted.push({ channel, data }) },
	} as any, {
		setInterval: (callback: () => void, ms: number) => {
			expect(ms).toBe(100);
			ticks.push(callback);
			return {};
		},
		clearInterval: () => {},
	});
	return { handlers, widgets, emitted, ctx, ticks };
}

/** Drive a streaming episode: thinking deltas then a finalized message. */
function streamThinking(
	handlers: Map<string, Handler>,
	ctx: any,
	thinking: string,
	usage?: { reasoning?: number },
) {
	const partial = { role: "assistant", content: [{ type: "thinking", thinking }] };
	handlers.get("message_update")?.({
		message: partial,
		assistantMessageEvent: { type: "thinking_delta", delta: thinking },
	}, ctx);
	handlers.get("message_end")?.({
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking }],
			usage,
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

	test("formats the widget line with themed spinner and dim text", () => {
		const identity = (color: "accent" | "dim", text: string) => `<${color}>${text}</${color}>`;
		const line = formatWidgetLine(1200, 1, identity);
		expect(line).toBe("<accent>⠙</accent> <dim>Thinking… 1.2k</dim>");
	});
});

describe("widget lifecycle", () => {
	test("shows the widget while thinking streams, then drops it and emits the exact count", () => {
		const { handlers, widgets, emitted, ctx } = setup();

		streamThinking(handlers, ctx, "a".repeat(400), { reasoning: 1234 });

		// Widget up on first thinking delta, down on settle. Exactly two pushes:
		// no per-token churn.
		expect(widgets).toHaveLength(2);
		expect(widgets[0]).toContain("Thinking… 100");
		expect(widgets[1]).toBeUndefined();
		expect(emitted).toEqual([{
			channel: THINKING_TOKENS_EVENT,
			data: { reasoningTokens: 1234, exact: true },
		}]);
	});

	test("keeps the streamed estimate when the provider does not report reasoning tokens", () => {
		const { handlers, emitted, ctx } = setup();

		streamThinking(handlers, ctx, "a".repeat(400));

		expect(emitted).toEqual([{
			channel: THINKING_TOKENS_EVENT,
			data: { reasoningTokens: 100, exact: false },
		}]);
	});

	test("ticks coalesce token bursts into one push per interval", () => {
		const { handlers, widgets, ctx, ticks } = setup();

		const partial = (thinking: string) => ({
			message: { role: "assistant", content: [{ type: "thinking", thinking }] },
			assistantMessageEvent: { type: "thinking_delta", delta: thinking },
		});

		// First delta: immediate push + tick started.
		handlers.get("message_update")?.(partial("a".repeat(40)), ctx);
		expect(widgets).toHaveLength(1);

		// Burst of deltas inside the same tick window: no extra pushes.
		handlers.get("message_update")?.(partial("a".repeat(80)), ctx);
		handlers.get("message_update")?.(partial("a".repeat(120)), ctx);
		expect(widgets).toHaveLength(1);

		// The tick renders the latest state exactly once, with a fresh spinner.
		const before = widgets[0];
		ticks[0]?.();
		expect(widgets).toHaveLength(2);
		expect(widgets[1]).not.toBe(before);
		expect(widgets[1]).toContain("Thinking… 30");

		handlers.get("message_end")?.({
			message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(120) }], usage: {} },
		}, ctx);
		expect(widgets.at(-1)).toBeUndefined();
	});

	test("spinner cycles through frames across ticks", () => {
		const { handlers, widgets, ctx, ticks } = setup();

		handlers.get("message_update")?.({
			message: { role: "assistant", content: [{ type: "thinking", thinking: "abcd" }] },
		}, ctx);
		const seen = new Set([widgets[0]]);
		for (let i = 0; i < 4; i++) {
			ticks[0]?.();
			seen.add(widgets.at(-1));
		}
		// Multiple distinct spinner frames observed across ticks.
		expect(seen.size).toBeGreaterThan(2);
	});

	test("never touches the widget for messages without thinking", () => {
		const { handlers, widgets, emitted, ctx } = setup();

		handlers.get("message_update")?.({
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			assistantMessageEvent: { type: "text_delta", delta: "hi" },
		}, ctx);
		handlers.get("message_end")?.({ message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }, ctx);
		handlers.get("message_end")?.({ message: { role: "toolResult", content: [] } }, ctx);

		expect(widgets).toEqual([]);
		expect(emitted).toEqual([]);
	});

	test("agent_settled clears a stale widget after an aborted stream", () => {
		const { handlers, widgets, ctx } = setup();

		handlers.get("message_update")?.({
			message: { role: "assistant", content: [{ type: "thinking", thinking: "abcd" }] },
		}, ctx);
		handlers.get("agent_settled")?.({}, ctx);

		expect(widgets.at(-1)).toBeUndefined();
	});

	test("session_shutdown drops the widget", () => {
		const { handlers, widgets, ctx } = setup();

		handlers.get("session_shutdown")?.({}, ctx);

		expect(widgets).toEqual([undefined]);
	});
});
