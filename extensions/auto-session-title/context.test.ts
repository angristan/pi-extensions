/**
 * Dependency graph:
 * Direct: `./context`, `bun:test`.
 * Used by: `Bun test runner`.
 */
import { describe, expect, test } from "bun:test";
import {
	buildTitleContext,
	buildTitlePrompt,
	createTitleState,
	latestTitleState,
	MAX_BOOTSTRAP_MESSAGE_CHARS,
	MAX_BOOTSTRAP_PRIOR_TURNS,
	MAX_CURRENT_ASSISTANT_CHARS,
	MAX_CURRENT_USER_CHARS,
	MAX_FOCUS_SUMMARY_CHARS,
	MAX_RECENT_TURN_SUMMARIES,
	MAX_TITLE_CONTEXT_CHARS,
	MAX_TURN_SUMMARY_CHARS,
	parseTitleModelResponse,
	TITLE_STATE_TYPE,
	titleStates,
} from "./context";

function stateEntry(index: number) {
	return {
		type: "custom",
		customType: TITLE_STATE_TYPE,
		data: {
			version: 2,
			turnSummary: `Turn ${index}`,
			focusSummary: `Focus ${index}`,
			title: `Title ${index}`,
			basedOnLeafId: `leaf-${index}`,
			createdAt: `2026-07-16T00:00:${String(index).padStart(2, "0")}.000Z`,
		},
	};
}

describe("auto-session-title context", () => {
	test("uses recent branch summaries and the current completed turn", () => {
		const entries = [
			...Array.from({ length: 10 }, (_, index) => stateEntry(index)),
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Remove descriptions and dedupe snippets." }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "edit" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Updated the Mistral web-search extension and pushed the change." }] } },
		];
		const context = buildTitleContext(entries);
		expect(context.previousFocus).toBe("Focus 9");
		expect(context.recentTurnSummaries).toEqual(Array.from({ length: 8 }, (_, index) => `Turn ${index + 2}`));
		expect(context.currentUserRequest).toBe("Remove descriptions and dedupe snippets.");
		expect(context.currentAssistantOutcome).toBe("Updated the Mistral web-search extension and pushed the change.");
		expect(latestTitleState(entries)?.title).toBe("Title 9");
	});

	test("keeps provisional first prompts out of completed assistant context", () => {
		const context = buildTitleContext([], "Start improving session titles");
		expect(context.currentUserRequest).toBe("Start improving session titles");
		expect(context.currentAssistantOutcome).toBeUndefined();
		expect(context.recentTurnSummaries).toEqual([]);
		expect(context.bootstrapPriorTurns).toEqual([]);
	});

	test("bootstraps legacy sessions from the latest three completed turns", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "Use AX for website content." } },
			{ type: "message", message: { role: "assistant", content: "Configured AX." } },
			{ type: "message", message: { role: "user", content: "Improve Mistral web-search output." } },
			{ type: "message", message: { role: "assistant", content: "Improved Mistral web-search rendering." } },
			{ type: "message", message: { role: "user", content: "Tune automatic session title prompts." } },
			{ type: "message", message: { role: "assistant", content: "Updated automatic title focus rules." } },
			{ type: "message", message: { role: "user", content: "Add rolling summaries to automatic session titles." } },
			{ type: "message", message: { role: "assistant", content: "Implemented rolling title summaries and branch persistence." } },
		];
		const context = buildTitleContext(entries);
		expect(context.previousFocus).toBeUndefined();
		expect(context.recentTurnSummaries).toEqual([]);
		expect(context.bootstrapPriorTurns).toEqual([
			{
				userRequest: "Improve Mistral web-search output.",
				assistantOutcome: "Improved Mistral web-search rendering.",
			},
			{
				userRequest: "Tune automatic session title prompts.",
				assistantOutcome: "Updated automatic title focus rules.",
			},
		]);
		expect(context.currentUserRequest).toBe("Add rolling summaries to automatic session titles.");
		expect(context.currentAssistantOutcome).toBe("Implemented rolling title summaries and branch persistence.");
	});

	test("enforces every context and prompt cap", () => {
		const huge = "word ".repeat(2_000);
		const entries = [
			...Array.from({ length: MAX_RECENT_TURN_SUMMARIES }, (_, index) => ({
				type: "custom",
				customType: TITLE_STATE_TYPE,
				data: {
					version: 2,
					turnSummary: huge,
					focusSummary: huge,
					title: "Long Session",
					createdAt: `2026-07-16T00:00:${String(index).padStart(2, "0")}.000Z`,
				},
			})),
			{ type: "message", message: { role: "user", content: huge } },
			{ type: "message", message: { role: "assistant", content: huge } },
		];
		const context = buildTitleContext(entries);
		expect(context.currentUserRequest!.length).toBeLessThanOrEqual(MAX_CURRENT_USER_CHARS);
		expect(context.currentAssistantOutcome!.length).toBeLessThanOrEqual(MAX_CURRENT_ASSISTANT_CHARS);
		expect(context.previousFocus!.length).toBeLessThanOrEqual(MAX_FOCUS_SUMMARY_CHARS);
		expect(context.recentTurnSummaries).toHaveLength(MAX_RECENT_TURN_SUMMARIES);
		expect(context.recentTurnSummaries[0]!.length).toBeLessThanOrEqual(MAX_TURN_SUMMARY_CHARS);
		expect(context.recentTurnSummaries.length).toBeLessThanOrEqual(MAX_RECENT_TURN_SUMMARIES);
		expect(buildTitlePrompt("project", "Previous Title", context).length).toBeLessThanOrEqual(MAX_TITLE_CONTEXT_CHARS);

		const legacyEntries = Array.from({ length: MAX_BOOTSTRAP_PRIOR_TURNS + 1 }, () => [
			{ type: "message", message: { role: "user", content: huge } },
			{ type: "message", message: { role: "assistant", content: huge } },
		]).flat();
		const legacyContext = buildTitleContext(legacyEntries);
		expect(legacyContext.bootstrapPriorTurns).toHaveLength(MAX_BOOTSTRAP_PRIOR_TURNS);
		for (const turn of legacyContext.bootstrapPriorTurns) {
			expect(turn.userRequest.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_MESSAGE_CHARS);
			expect(turn.assistantOutcome.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_MESSAGE_CHARS);
		}
		expect(buildTitlePrompt("project", "Previous Title", legacyContext).length).toBeLessThanOrEqual(MAX_TITLE_CONTEXT_CHARS);
	});

	test("parses JSON, fenced JSON, and legacy plain titles", () => {
		expect(parseTitleModelResponse(JSON.stringify({
			turn_summary: "Improved search output.",
			focus_summary: "Ongoing Mistral web-search work.",
			title: "Mistral Web Search",
		}))).toEqual({
			turnSummary: "Improved search output.",
			focusSummary: "Ongoing Mistral web-search work.",
			title: "Mistral Web Search",
		});
		expect(parseTitleModelResponse("```json\n{\"turn_summary\":\"Turn\",\"focus_summary\":\"Focus\",\"title\":\"Session Titles\"}\n```"))
			.toEqual({ turnSummary: "Turn", focusSummary: "Focus", title: "Session Titles" });
		expect(parseTitleModelResponse("Legacy Title")).toEqual({ title: "Legacy Title" });
	});

	test("persists valid state and ignores malformed branch entries", () => {
		const state = createTitleState({
			turnSummary: "Summarized one completed turn.",
			focusSummary: "Maintaining automatic session titles.",
			title: "Session Titles",
		}, "leaf-1");
		const entries = [
			{ type: "custom", customType: TITLE_STATE_TYPE, data: { version: 1, turnSummary: "", focusSummary: "", title: "" } },
			{ type: "custom", customType: TITLE_STATE_TYPE, data: state },
		];
		expect(titleStates(entries)).toEqual([state]);
		expect(latestTitleState(entries)).toEqual(state);
	});
});
