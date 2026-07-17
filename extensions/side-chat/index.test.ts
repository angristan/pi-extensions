import { expect, test } from "bun:test";
import { buildSidePrompt } from "./index";

test("wraps the inherited conversation and explicit question separately", () => {
	const result = buildSidePrompt("user: main task\nassistant: working", "  What changed?  ", 100_000);
	expect(result.truncated).toBe(false);
	expect(result.prompt).toContain("<inherited_conversation>\nuser: main task");
	expect(result.prompt).toContain("<side_question>\nWhat changed?\n</side_question>");
});

test("bounds oversized inherited context while retaining its head and recent tail", () => {
	const conversation = `HEAD-${"a".repeat(90_000)}-TAIL`;
	const result = buildSidePrompt(conversation, "summarize", 1_000);

	expect(result.truncated).toBe(true);
	expect(result.prompt).toContain("HEAD-");
	expect(result.prompt).toContain("-TAIL");
	expect(result.prompt).toContain("inherited conversation omitted for the bounded side request");
	expect(result.prompt.length).toBeLessThan(conversation.length);
});
