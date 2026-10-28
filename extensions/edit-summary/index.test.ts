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

test("compact overlay title summarizes file and line totals", () => {
	const handlers = new Map<string, any>();
	editSummary({
		registerCommand() {},
		on: (name: string, handler: any) => handlers.set(name, handler),
	} as any);
	handlers.get("session_start")?.({}, {
		sessionManager: {
			getBranch: () => [{
				type: "custom",
				customType: "edit-summary-state-v1",
				data: {
					completedAt: 1,
					files: [
						{ path: "a.ts", status: "modified", additions: 3, removals: 1 },
						{ path: "b.ts", status: "added", additions: 2, removals: 0 },
					],
				},
			}],
		},
	});
	try {
		// The overlay registry is process-global so cards and the host share it.
		const registry = (globalThis as any)[Symbol.for("pi-extensions.overlay-stack.registry.v1")];
		const card = registry.cards.get("edit-summary").definition;
		const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
		expect(card.compactTitle(theme)).toBe(" File edits · 2 files +5 -1 ");
	} finally {
		handlers.get("session_shutdown")?.();
	}
});
