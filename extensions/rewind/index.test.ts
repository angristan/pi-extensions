import { expect, test } from "bun:test";
import rewind from "./index";

test("rewinds to the selected recent prompt and restores it in the fresh editor", async () => {
	const commands = new Map<string, any>();
	rewind({ registerCommand: (name: string, options: any) => commands.set(name, options) } as any);
	let forkedId: string | undefined;
	let restored = "";
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{ id: "old", type: "message", message: { role: "user", content: "older prompt" } },
				{ id: "assistant", type: "message", message: { role: "assistant", content: "answer" } },
				{ id: "new", type: "message", message: { role: "user", content: [{ type: "text", text: "newer\nprompt" }] } },
			],
		},
		ui: {
			select: async (_title: string, labels: string[]) => labels[0],
			confirm: async () => true,
			notify() {},
		},
		fork: async (id: string, options: any) => {
			forkedId = id;
			expect(options.position).toBe("before");
			await options.withSession({ ui: { setEditorText: (text: string) => { restored = text; } } });
		},
	};

	expect(commands.get("undo").handler).toBe(commands.get("rewind").handler);
	await commands.get("rewind").handler("", ctx);
	expect(forkedId).toBe("new");
	expect(restored).toBe("newer\nprompt");
});

test("reports when there is no user prompt to rewind", async () => {
	let command: any;
	rewind({ registerCommand: (name: string, options: any) => { if (name === "rewind") command = options; } } as any);
	const notices: string[] = [];
	await command.handler("", {
		sessionManager: { getBranch: () => [] },
		ui: { notify: (message: string) => notices.push(message) },
	});
	expect(notices).toEqual(["No earlier user prompts found."]);
});
