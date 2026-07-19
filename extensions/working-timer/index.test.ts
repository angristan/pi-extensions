import { expect, test } from "bun:test";
import workingTimer from "./index";

test("uses a lower-frequency working indicator and restores the default on shutdown", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const indicators: any[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWorkingIndicator: (indicator?: any) => indicators.push(indicator),
			setWorkingMessage() {},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	expect(indicators[0]?.intervalMs).toBe(250);
	expect(indicators[0]?.frames).toHaveLength(10);

	handlers.get("session_shutdown")?.({}, ctx);
	expect(indicators.at(-1)).toBeUndefined();
});

test("starts once per visible run and restores Pi's working message when settled", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const messages: Array<string | undefined> = [];
	const ctx = {
		mode: "tui",
		ui: { setWorkingMessage: (message?: string) => messages.push(message) },
	};

	handlers.get("agent_start")?.({}, ctx);
	expect(messages).toHaveLength(1);
	expect(messages[0]).toStartWith("Working (0s");
	handlers.get("agent_start")?.({}, ctx);
	expect(messages).toHaveLength(1);

	handlers.get("agent_settled")?.({}, ctx);
	expect(messages.at(-1)).toBeUndefined();
});
