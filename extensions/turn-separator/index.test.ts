import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import turnSeparator from "./index";
import { RESPONSE_TIMING_EVENT } from "../turn-stats/index";

test("adds a labeled separator only after an assistant step performs tool work", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let renderer: any;
	const entries: any[] = [];
	const eventHandlers = new Map<string, (event: unknown) => void>();
	turnSeparator({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerEntryRenderer: (_name: string, value: any) => { renderer = value; },
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		events: {
			on: (name: string, handler: (event: unknown) => void) => {
				eventHandlers.set(name, handler);
				return () => eventHandlers.delete(name);
			},
		},
	} as any);
	handlers.get("session_start")?.();
	handlers.get("message_start")?.({ message: { role: "assistant" } });
	handlers.get("message_start")?.({ message: { role: "toolResult" } });
	eventHandlers.get(RESPONSE_TIMING_EVENT)?.({ outputTokens: 84, ttftMs: 480, tokensPerSecond: 42 });
	handlers.get("tool_execution_start")?.({});
	handlers.get("message_start")?.({ message: { role: "assistant" } });
	expect(entries).toHaveLength(1);
	expect(entries[0].data).toMatchObject({ ttftMs: 480, tokensPerSecond: 42 });
	expect(entries[0].data.elapsedSeconds).toBeGreaterThanOrEqual(0);

	const identityTheme = { fg: (_color: string, text: string) => text };
	const metricsOnly = renderer({ data: entries[0].data }, {}, identityTheme).render(64)[0];
	expect(metricsOnly).toBe(`${"─".repeat(38)} ttft 480ms · tps 42/s ─`);
	expect(visibleWidth(metricsOnly)).toBe(62);

	const labeled = renderer({ data: { ...entries[0].data, elapsedSeconds: 61 } }, {}, identityTheme).render(64)[0];
	expect(labeled).toContain("Worked for 1m 1s");
	expect(labeled).toContain("ttft 480ms · tps 42/s");
	expect(visibleWidth(labeled)).toBeLessThanOrEqual(62);

	handlers.get("message_start")?.({ message: { role: "assistant" } });
	expect(entries).toHaveLength(1);
});
