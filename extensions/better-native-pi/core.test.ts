import { describe, expect, test } from "bun:test";
import { buildToolBlock, REASONING_DESCRIPTION, withReasoning } from "./core.js";

const ANSI_PATTERN = /\x1b\[[0-9;:]*m/g;
const TEST_TAG_PATTERN = /<\/?(?:bold|green|magenta|red)>|<\/>/g;

function plain(text: string): string {
	return text.replace(ANSI_PATTERN, "").replace(TEST_TAG_PATTERN, "");
}

describe("withReasoning", () => {
	test("keeps required reasoning metadata compact and first", () => {
		const schema = withReasoning({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});

		expect(Object.keys(schema.properties)).toEqual(["reasoning", "path"]);
		expect(schema.required).toEqual(["reasoning", "path"]);
		expect(schema.properties.reasoning.description).toBe(REASONING_DESCRIPTION);
		expect(REASONING_DESCRIPTION.length).toBeLessThanOrEqual(100);
	});
});

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

		const headline = plain(lines[0]);
		expect(headline).toContain("• Ran exercise full unified terminal regression suite");
		expect(headline).toContain("✗ exit 1");
		expect(headline).not.toContain("bun test v1.3.9");
		expect(headline).not.toContain("61 tests failed");
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

		const headline = plain(lines[0]);
		expect(headline).toContain("• Ran run command");
		expect(headline).toContain("✗");
		expect(headline).not.toContain("spawn failed");
	});
});
