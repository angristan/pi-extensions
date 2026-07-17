import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import editSummary, { countPatchChanges, truncateMiddleToWidth } from "./index";

test("counts changed lines without treating patch headers as edits", () => {
	const patch = [
		"--- a/file.ts",
		"+++ b/file.ts",
		"@@ -1,2 +1,3 @@",
		"-old",
		"+new",
		"+added",
		" context",
	].join("\n");
	expect(countPatchChanges(patch)).toEqual({ additions: 2, removals: 1 });
});

test("middle truncation preserves useful path context within terminal width", () => {
	const result = truncateMiddleToWidth("src/very/long/component/index.test.ts", 18);
	expect(visibleWidth(result)).toBeLessThanOrEqual(18);
	expect(result).toStartWith("src/");
	expect(result).toEndWith(".test.ts");
});

test("validates overlay command actions and offers completions", () => {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	editSummary({
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (name: string, handler: any) => handlers.set(name, handler),
	} as any);
	const notices: Array<[string, string]> = [];
	const ctx = { ui: { notify: (...args: [string, string]) => notices.push(args) } };
	const command = commands.get("edit-summary");

	expect(command.getArgumentCompletions("h")).toEqual([{ value: "hide", label: "hide" }]);
	command.handler("invalid", ctx);
	expect(notices.at(-1)).toEqual(["Usage: /edit-summary [show|hide|toggle]", "warning"]);
	command.handler("hide", ctx);
	expect(notices.at(-1)?.[0]).toBe("Edit summary overlay hidden.");
	handlers.get("session_shutdown")?.();
});
