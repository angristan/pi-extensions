import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import turnSeparator from "./index";

test("adds a labeled separator only after an assistant step performs tool work", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let renderer: any;
	const entries: any[] = [];
	turnSeparator({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerEntryRenderer: (_name: string, value: any) => { renderer = value; },
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
	} as any);
	handlers.get("message_start")?.({ message: { role: "assistant" } });
	handlers.get("message_start")?.({ message: { role: "toolResult" } });
	handlers.get("tool_execution_start")?.({});
	handlers.get("message_start")?.({ message: { role: "assistant" } });
	expect(entries).toHaveLength(1);
	expect(entries[0].data.elapsedSeconds).toBeGreaterThanOrEqual(0);

	const component = renderer({ data: { elapsedSeconds: 61 } }, {}, { fg: (_color: string, text: string) => text });
	const line = component.render(30)[0];
	expect(line).toContain("Worked for 1m 1s");
	expect(visibleWidth(line)).toBeLessThanOrEqual(28);

	handlers.get("message_start")?.({ message: { role: "assistant" } });
	expect(entries).toHaveLength(1);
});
