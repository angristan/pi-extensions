import { expect, test } from "bun:test";
import workingTimer from "./index";

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
