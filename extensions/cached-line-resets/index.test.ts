import { expect, test } from "bun:test";
import cachedLineResets from "./index";

test("caches repeated line normalization and restores the original TUI method", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let widgetFactory: any;
	cachedLineResets({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const ctx = {
		mode: "tui",
		ui: { setWidget(_key: string, value: any) { widgetFactory = value; } },
	};
	let calls = 0;
	const original = (lines: string[]) => {
		calls += lines.length;
		return lines.map((line) => `${line}!`);
	};
	const tui: any = { applyLineResets: original };

	handlers.get("session_start")?.({}, ctx);
	const host = widgetFactory(tui);
	expect(tui.applyLineResets(["same", "same"])).toEqual(["same!", "same!"]);
	expect(tui.applyLineResets(["same"])).toEqual(["same!"]);
	expect(calls).toBe(1);

	host.dispose();
	expect(tui.applyLineResets).toBe(original);
});
