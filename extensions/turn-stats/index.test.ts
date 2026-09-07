import { expect, spyOn, test } from "bun:test";
import turnStats, { aggregateResponseTimings, formatDuration, RESPONSE_TIMING_EVENT } from "./index";

test("formats user-visible run durations", () => {
	expect(formatDuration(400)).toBe("<1s");
	expect(formatDuration(61_000)).toBe("1m 01s");
	expect(formatDuration(3_661_000)).toBe("1h 01m");
});

test("averages TTFT and weights TPS by generation time", () => {
	const summary = aggregateResponseTimings([
		{ requestStartedAt: 0, firstTokenAt: 100, endedAt: 1_100, outputTokens: 100, ttftMs: 100, tokensPerSecond: 100 },
		{ requestStartedAt: 2_000, firstTokenAt: 2_400, endedAt: 4_400, outputTokens: 100, ttftMs: 400, tokensPerSecond: 50 },
	]);

	expect(summary).toMatchObject({ responseCount: 2, averageTtftMs: 250 });
	expect(summary?.tokensPerSecond).toBeCloseTo(66.667, 3);
});

// An empty reasoning block can arrive seconds before any generated content.
// Replay that delay through the public hooks and check both timing consumers.
function measureResponse(firstContent?: Record<string, unknown>) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const emitted: Array<{ channel: string; data: any }> = [];
	const entries: any[] = [];
	let now = 1_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		turnStats({
			on: (name: string, handler: any) => handlers.set(name, handler),
			registerEntryRenderer: () => {},
			appendEntry: (_type: string, data: any) => entries.push(data),
			events: { emit: (channel: string, data: any) => emitted.push({ channel, data }) },
		} as any);
		const update = (event: Record<string, unknown>) => handlers.get("message_update")?.({
			message: { role: "assistant" }, assistantMessageEvent: event,
		});
		handlers.get("agent_start")?.();
		handlers.get("before_provider_request")?.();
		now = 2_000;
		for (const type of ["thinking_start", "text_start", "toolcall_start"]) update({ type });
		for (const type of ["thinking_delta", "text_delta", "toolcall_delta"]) update({ type, delta: "" });
		for (const type of ["thinking_end", "text_end"]) update({ type, content: "" });
		if (firstContent) {
			now = 6_000;
			update(firstContent);
			// Later content must not replace the first content's timestamp.
			now = 8_000;
			update({ type: "text_delta", delta: "Answer" });
		}
		now = 11_000;
		handlers.get("message_end")?.({
			message: { role: "assistant", usage: { output: firstContent ? 600 : 0 } },
		}, { modelRegistry: { find: () => undefined } });
		handlers.get("agent_settled")?.();
		return { response: emitted.find(event => event.channel === RESPONSE_TIMING_EVENT)?.data, run: entries[0] };
	} finally {
		clock.mockRestore();
	}
}

for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
	test(`measures TTFT and TPS from the first non-empty ${type}`, () => {
		const { response, run } = measureResponse({ type, delta: "content" });
		expect(response).toMatchObject({ outputTokens: 600, ttftMs: 5_000, tokensPerSecond: 120 });
		expect(run.averageTiming).toEqual({ responseCount: 1, averageTtftMs: 5_000, tokensPerSecond: 120 });
	});
}

for (const event of [
	{ type: "text_end", content: "Answer" },
	{ type: "thinking_end", content: "Reasoning" },
	{ type: "toolcall_end", toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} } },
]) {
	test(`uses completed content when a provider only emits ${event.type}`, () => {
		expect(measureResponse(event).response).toMatchObject({ ttftMs: 5_000, tokensPerSecond: 120 });
	});
}

test("does not report TTFT for a response with only empty blocks", () => {
	const { response, run } = measureResponse();
	expect(response.ttftMs).toBeUndefined();
	expect(response.tokensPerSecond).toBeUndefined();
	expect(run.averageTiming.averageTtftMs).toBeUndefined();
});

test("records timing and aggregate usage when the full run settles", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let renderer: any;
	const entries: any[] = [];
	const emitted: Array<{ channel: string; data: any }> = [];
	turnStats({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerEntryRenderer: (_name: string, value: any) => { renderer = value; },
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		events: {
			emit: (channel: string, data: any) => emitted.push({ channel, data }),
		},
	} as any);
	const ctx = { modelRegistry: { find: () => undefined } };
	handlers.get("session_start")?.();
	handlers.get("agent_start")?.();
	handlers.get("before_provider_request")?.();
	handlers.get("message_update")?.({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hi" } });
	handlers.get("message_end")?.({
		message: {
			role: "assistant",
			usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, cost: { total: 0.5 } },
		},
	}, ctx);
	handlers.get("message_end")?.({
		message: {
			role: "toolResult",
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.1 } },
		},
	}, ctx);
	handlers.get("session_compact")?.({
		compactionEntry: {
			usage: { input: 7, output: 11, cacheRead: 13, cacheWrite: 17, cost: { total: 0.2 } },
		},
	});
	handlers.get("agent_settled")?.();

	expect(entries).toHaveLength(1);
	expect(entries[0].data).toMatchObject({
		usage: { input: 19, output: 34, cacheRead: 47, cacheWrite: 22, cost: 0.8 },
	});
	expect(entries[0].data.cacheHitPercent).toBeCloseTo(53.409, 3);
	expect(entries[0].data.elapsedMs).toBeGreaterThanOrEqual(0);
	expect(entries[0].data.averageTiming).toMatchObject({ responseCount: 1 });
	expect(entries[0].data.averageTiming.averageTtftMs).toBeGreaterThanOrEqual(0);
	expect(emitted).toContainEqual({
		channel: RESPONSE_TIMING_EVENT,
		data: expect.objectContaining({ outputTokens: 20, ttftMs: expect.any(Number) }),
	});
	const identityTheme = { fg: (_color: string, text: string) => text };
	const rendered = renderer({ data: {
		endedAt: Date.now(),
		elapsedMs: 2_000,
		averageTiming: { responseCount: 3, averageTtftMs: 200, tokensPerSecond: 20 },
		usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.5 },
		cacheHitPercent: 75,
	} }, {}, identityTheme).render(120).join("\n");
	expect(rendered).toContain("duration 2s");
	expect(rendered).toContain("ttft 200ms");
	expect(rendered).toContain("tps 20/s");
	expect(rendered).not.toContain("avg");
	expect(rendered).toContain("hit 75%");
	expect(rendered).toContain("$0.50");
});
