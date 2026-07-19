import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "bun:test";
import renameExtension from "./index";

type NoticeLevel = "info" | "warning" | "error";
type CommandContext = {
	ui: { notify: (message: string, level: NoticeLevel) => void };
};
type RenameCommand = {
	description: string;
	handler: (args: string, ctx: CommandContext) => void;
};

function setup(initialName?: string, normalize: (name: string) => string = (name) => name) {
	let sessionName = initialName;
	let commandName: string | undefined;
	let command: RenameCommand | undefined;
	const notices: Array<[string, NoticeLevel]> = [];
	const pi = {
		registerCommand(name: string, options: RenameCommand) {
			commandName = name;
			command = options;
		},
		getSessionName() {
			return sessionName;
		},
		setSessionName(name: string) {
			sessionName = normalize(name);
		},
	};

	renameExtension(pi as unknown as ExtensionAPI);
	if (!command) throw new Error("rename command was not registered");
	const ctx: CommandContext = { ui: { notify: (message, level) => notices.push([message, level]) } };
	return { commandName, command, ctx, notices, getSessionName: () => sessionName };
}

test("registers /rename as a /name alias", () => {
	const { commandName, command } = setup();
	expect(commandName).toBe("rename");
	expect(command.description).toContain("alias for /name");
});

test("renames the current session", () => {
	const { command, ctx, notices, getSessionName } = setup();
	command.handler("  Updated session  ", ctx);
	expect(getSessionName()).toBe("Updated session");
	expect(notices).toEqual([["Session name set: Updated session", "info"]]);
});

test("shows the current name or usage without arguments", () => {
	const named = setup("Current session");
	named.command.handler("", named.ctx);
	expect(named.notices).toEqual([["Session name: Current session", "info"]]);

	const unnamed = setup();
	unnamed.command.handler("", unnamed.ctx);
	expect(unnamed.notices).toEqual([["Usage: /rename <name>", "warning"]]);
});

test("reports host normalization", () => {
	const { command, ctx, notices } = setup(undefined, (name) => name.replace(/\s+/g, " "));
	command.handler("Multi\nline", ctx);
	expect(notices).toEqual([
		['Session name was normalized from "Multi\\nline" to "Multi line"', "warning"],
		["Session name set: Multi line", "info"],
	]);
});
