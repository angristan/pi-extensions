import { expect, test } from "bun:test";
import { IMAGE_PREVIEW_VISIBLE_EVENT } from "../image-store/index";
import workingTimer from "./index";

test("starts once per visible run and restores Pi's working message when settled", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const eventHandlers = new Map<string, (...args: any[]) => any>();
	workingTimer({
		on: (name: string, handler: any) => handlers.set(name, handler),
		events: {
			on(name: string, handler: any) {
				eventHandlers.set(name, handler);
				return () => eventHandlers.delete(name);
			},
		},
	} as any);
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

	eventHandlers.get(IMAGE_PREVIEW_VISIBLE_EVENT)?.();
	handlers.get("agent_start")?.({}, ctx); // retry must not restart redraws
	expect(messages).toHaveLength(1);

	handlers.get("agent_settled")?.({}, ctx);
	expect(messages.at(-1)).toBeUndefined();
	handlers.get("session_shutdown")?.({}, ctx);
	expect(eventHandlers.has(IMAGE_PREVIEW_VISIBLE_EVENT)).toBeFalse();
});
