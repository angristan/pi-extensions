import { expect, test } from "bun:test";
import historySearch from "./index";

const identity = (text: string) => text;
const editorTheme = {
	borderColor: identity,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};

test("searches newest matching prompts, cycles results, and restores drafts on cancel", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	historySearch({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	let currentFactory: any;
	const ctx = {
		mode: "tui",
		sessionManager: {
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "older foo" } },
				{ type: "message", message: { role: "assistant", content: "ignored" } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "latest foo" }] } },
			],
		},
		ui: {
			getEditorComponent: () => currentFactory,
			setEditorComponent: (factory: any) => { currentFactory = factory; },
		},
	};
	handlers.get("session_start")?.({}, ctx);
	const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
	const editor = currentFactory(tui, editorTheme, { matches: () => false });
	editor.setText("unfinished draft");

	editor.handleInput("\x12"); // Ctrl+R
	for (const char of "foo") editor.handleInput(char);
	expect(editor.getText()).toBe("latest foo");
	expect(editor.render(80).join("\n")).toContain("1/2");
	editor.handleInput("\x12");
	expect(editor.getText()).toBe("older foo");
	editor.handleInput("\x1b");
	expect(editor.getText()).toBe("unfinished draft");

	const installed = currentFactory;
	handlers.get("session_shutdown")?.({}, ctx);
	expect(currentFactory).not.toBe(installed);
});
