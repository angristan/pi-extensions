import { describe, expect, test } from "bun:test";
import { formatShellCommandForDisplay } from "./shell.js";

describe("formatShellCommandForDisplay", () => {
	test("breaks long chains at top-level operators", () => {
		const command = "cd /a/long/project/path && rm -rf /tmp/build-check && bun build src/index.ts --target=node && git diff --check";
		const lines = formatShellCommandForDisplay(command, 48);

		expect(lines[0]).toEndWith("&&");
		expect(lines.some((line) => line.startsWith("rm "))).toBe(true);
		expect(lines.some((line) => line.startsWith("bun "))).toBe(true);
		expect(lines.some((line) => line.startsWith("git "))).toBe(true);
		expect(lines.every((line) => line.length <= 48)).toBe(true);
	});

	test("does not split operators inside quotes or substitutions", () => {
		const command = `printf '%s\\n' "hello && quoted" "$(printf 'nested | value')" && echo done`;
		const lines = formatShellCommandForDisplay(command, 68);

		expect(lines.join("\n")).toContain('"hello && quoted"');
		expect(lines.join("\n")).toContain('"$(printf \'nested | value\')"');
		expect(lines.at(-1)?.trim()).toBe("echo done");
	});

	test("keeps explicit short multiline commands unchanged", () => {
		const command = `for item in alpha beta; do\n  printf '%s\\n' "$item"\ndone`;
		expect(formatShellCommandForDisplay(command, 80)).toEqual(command.split("\n"));
	});

	test("attaches a stranded operator to the following command", () => {
		const command = "  src/renderer.test.ts && echo done";
		const lines = formatShellCommandForDisplay(command, 24);

		expect(lines).toEqual(["  src/renderer.test.ts", "    && echo done"]);
	});
});
