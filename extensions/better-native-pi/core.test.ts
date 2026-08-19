import { describe, expect, test } from "bun:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildToolBlock,
	normalizeToolReasoning,
	normalizeToolReasoningInput,
	renderCommandOutput,
	REASONING_DESCRIPTION,
	withReasoning,
} from "./core.js";

const ANSI_PATTERN = /\x1b\[[0-9;:]*m/g;
const OSC8_PATTERN = /\x1b\]8;;.*?(?:\x07|\x1b\\)/g;
const TEST_TAG_PATTERN = /<link:[^>]+>|<\/link>|<\/?(?:bold|cyan|dim|green|magenta|red)>|<\/>/g;

function plain(text: string): string {
	return text.replace(ANSI_PATTERN, "").replace(OSC8_PATTERN, "").replace(TEST_TAG_PATTERN, "");
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
		expect(REASONING_DESCRIPTION).toContain("Start lowercase");
		expect(REASONING_DESCRIPTION).toContain("no period");
		expect(REASONING_DESCRIPTION.length).toBeLessThanOrEqual(100);
	});

	test("lowercases Title-case starts while preserving acronyms and brands", () => {
		expect(normalizeToolReasoning("Inspect API behavior")).toBe("inspect API behavior");
		expect(normalizeToolReasoning("API review")).toBe("API review");
		expect(normalizeToolReasoning("iOS build check")).toBe("iOS build check");
		expect(normalizeToolReasoning("GitHub API review")).toBe("GitHub API review");
		expect(normalizeToolReasoning("  Évaluer OCR output")).toBe("  évaluer OCR output");
	});

	test("normalizes mutable tool input for every extension", () => {
		const input = { reasoning: "Verify shared casing", path: "src" };
		normalizeToolReasoningInput(input);
		expect(input).toEqual({ reasoning: "verify shared casing", path: "src" });
	});
});

describe("renderCommandOutput", () => {
	test("keeps collapsed omission markers within narrow terminal widths", () => {
		for (const rowCount of [18, 101]) {
			const output = Array.from(
				{ length: rowCount },
				(_, index) => `line ${index + 1}`,
			).join("\n");

			for (const width of [44, 46]) {
				const lines = renderCommandOutput(output, width, { maxRows: 2 });
				expect(lines).toHaveLength(2);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		}
	});
});

describe("buildToolBlock reasoning casing", () => {
	test("normalizes legacy Title-case reasons at render time", () => {
		const lines = buildToolBlock(
			"read",
			{ reasoning: "Inspect API behavior", path: "src/api.ts" },
			{ content: [{ type: "text", text: "one line" }] },
		);
		expect(plain(lines[0])).toContain("Read inspect API behavior");
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

describe("buildToolBlock grep summaries", () => {
	test("shows match and file counts", () => {
		const lines = buildToolBlock(
			"grep",
			{ reasoning: "find todo markers", pattern: "TODO", path: "src" },
			{ content: [{ type: "text", text: "a.ts:1: TODO one\nb.ts:4: TODO two" }] },
		);

		expect(plain(lines.join("\n"))).toContain("TODO in src · 2 matches in 2 files");
	});

	test("marks grep counts as lower bounds when the match limit is reached", () => {
		const lines = buildToolBlock(
			"grep",
			{ reasoning: "find repeated string", pattern: "needle", path: "src" },
			{
				content: [{ type: "text", text: "a.ts:1: needle\na.ts:2: needle" }],
				details: { matchLimitReached: 100 },
			},
		);

		expect(plain(lines.join("\n"))).toContain("needle in src · 100+ matches in 1 file");
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
