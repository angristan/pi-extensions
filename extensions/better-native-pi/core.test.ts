import { describe, expect, test } from "bun:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
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
		expect(REASONING_DESCRIPTION).toContain("≤8-word");
		expect(REASONING_DESCRIPTION).toContain("No period");
		expect(REASONING_DESCRIPTION.length).toBeLessThanOrEqual(100);
	});
});

describe("buildToolBlock write expansion", () => {
	const content = "export const x = 1;\nexport const y = 2;\n";
	const diff = generateDiffString("", content).diff;
	const args = { path: "worker/lib/http.ts", reasoning: "centralize request parsing", content };

	test("does not repeat content already covered by a new-file diff", () => {
		const lines = buildToolBlock(
			"write",
			args,
			{ content: [{ type: "text", text: "ok" }], details: { diff, diffCoversFullContent: true } },
			{ expanded: true },
		);

		expect(lines.filter((line) => plain(line).includes("export const x = 1;")).length).toBe(1);
		expect(lines.filter((line) => plain(line).includes("export const y = 2;")).length).toBe(1);
	});

	test("keeps complete expansion when a focused diff omits file content", () => {
		const lines = buildToolBlock(
			"write",
			args,
			{ content: [{ type: "text", text: "ok" }], details: { diff, diffCoversFullContent: false } },
			{ expanded: true },
		);

		expect(lines.filter((line) => plain(line).includes("export const x = 1;")).length).toBe(2);
		expect(lines.filter((line) => plain(line).includes("export const y = 2;")).length).toBe(2);
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
