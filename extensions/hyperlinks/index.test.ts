import { expect, test } from "bun:test";
import hyperlinks, { hyperlinkPath } from "./index";

test("creates an OSC 8 file link for a relative local path", () => {
	const rendered = hyperlinkPath("open me", "folder/a b.ts", "/tmp/project");
	expect(rendered).toContain("open me");
	expect(rendered).toContain("file:///tmp/project/folder/a%20b.ts");
	expect(rendered).toContain("\x1b]8;;");
});

test("the open-path command validates input and resolves against cwd", async () => {
	let command: any;
	hyperlinks({ registerCommand(_name: string, options: any) { command = options; } } as any);
	const notices: Array<[string, string]> = [];
	const ctx = { cwd: "/tmp/work", ui: { notify: (message: string, level: string) => notices.push([message, level]) } };

	await command.handler("   ", ctx);
	expect(notices.at(-1)).toEqual(["Usage: /open-path <path>", "warning"]);
	await command.handler("src/index.ts", ctx);
	expect(notices.at(-1)?.[0]).toContain("file:///tmp/work/src/index.ts");
});
