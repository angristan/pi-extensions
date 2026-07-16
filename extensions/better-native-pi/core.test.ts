import { describe, expect, test } from "bun:test";
import { buildToolBlock } from "./core.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function plain(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

describe("buildToolBlock bash summaries", () => {
	test("keeps failed command output out of the headline", () => {
		const result = {
			content: [{
				type: "text",
				text: "bun test v1.3.9 (cf6cdbbb)\n\n61 tests failed\n\nCommand exited with code 1",
			}],
		};

		const lines = buildToolBlock(
			"bash",
			{ reasoning: "exercise full unified terminal regression suite" },
			result,
			{ isError: true, elapsedMs: 2100 },
		);

		expect(plain(lines[0])).toBe("• Ran exercise full unified terminal regression suite in 2s ✗ exit 1");
		expect(plain(lines[0])).not.toContain("bun test v1.3.9");
	});

	test("keeps unknown bash errors marked as failed", () => {
		const result = {
			content: [{ type: "text", text: "spawn failed before producing an exit code" }],
		};

		const lines = buildToolBlock(
			"bash",
			{ reasoning: "run command" },
			result,
			{ isError: true, elapsedMs: 50 },
		);

		expect(plain(lines[0])).toBe("• Ran run command in 50ms ✗");
		expect(plain(lines[0])).not.toContain("spawn failed");
	});
});
