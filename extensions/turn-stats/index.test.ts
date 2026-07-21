import { expect, test } from "bun:test";
import turnStats, { formatDuration } from "./index";

test("formats user-visible run durations", () => {
	expect(formatDuration(400)).toBe("<1s");
	expect(formatDuration(61_000)).toBe("1m 01s");
	expect(formatDuration(3_661_000)).toBe("1h 01m");
});

test("records timing and aggregate usage when the full run settles", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let renderer: any;
	const entries: any[] = [];
	turnStats({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerEntryRenderer: (_name: string, value: any) => { renderer = value; },
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
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
	expect(entries[0].data.timing.ttftMs).toBeGreaterThanOrEqual(0);
	const identityTheme = { fg: (_color: string, text: string) => text };
	const rendered = renderer({ data: {
		endedAt: Date.now(),
		elapsedMs: 2_000,
		timing: { requestStartedAt: 0, ttftMs: 200, tokensPerSecond: 20 },
		usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, cost: 0.5 },
		cacheHitPercent: 75,
	} }, {}, identityTheme).render(120).join("\n");
	expect(rendered).toContain("duration 2s");
	expect(rendered).toContain("ttft 200ms");
	expect(rendered).toContain("tps 20/s");
	expect(rendered).toContain("hit 75%");
	expect(rendered).toContain("$0.50");
});
