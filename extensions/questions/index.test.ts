import { expect, test } from "bun:test";
import questions from "./index";

function registeredTool(events: Array<{ name: string; payload: any }> = []) {
	let tool: any;
	questions({
		registerTool: (definition: any) => { tool = definition; },
		events: { emit: (name: string, payload: any) => events.push({ name, payload }) },
	} as any);
	return tool;
}

test("collects structured option and free-text answers in order", async () => {
	const events: Array<{ name: string; payload: any }> = [];
	const tool = registeredTool(events);
	const selected: string[] = [];
	const prompts: string[] = [];
	const titles: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			select: async (question: string, options: string[]) => { prompts.push(question); selected.push(...options); return "Blue"; },
			input: async (question: string) => { prompts.push(question); return "Because it is calm"; },
			setTitle: (title: string) => titles.push(title),
		},
	};
	const result = await tool.execute("id", { questions: [
		{ id: "color", question: "Pick a color", options: ["Red", "Blue"], allow_other: false },
		{ id: "why", question: "Why?", allow_other: false },
	] }, undefined, undefined, ctx);

	expect(selected).toEqual(["Red", "Blue"]);
	expect(prompts).toEqual(["Question 1/2 · Pick a color", "Question 2/2 · Why?"]);
	expect(titles).toEqual(["❓ Input needed · Question 1/2", "❓ Input needed · Question 2/2", "pi"]);
	expect(events).toEqual([
		{ name: "terminal-title:override", payload: { source: "questions", title: "❓ Input needed · Question 1/2" } },
		{ name: "terminal-title:override", payload: { source: "questions", title: "❓ Input needed · Question 2/2" } },
		{ name: "terminal-title:override", payload: { source: "questions", title: undefined } },
	]);
	expect(result.content[0].text).toBe("color: Blue\nwhy: Because it is calm");
	expect(result.details.interrupted).toBe(false);
	expect(result.details.answers).toHaveLength(2);
});

test("stops after cancellation and never stores secret text", async () => {
	const tool = registeredTool();
	const notices: string[] = [];
	const result = await tool.execute("id", { questions: [
		{ id: "token", question: "API token?", secret: true, allow_other: false },
		{ id: "later", question: "Should not run" },
	] }, undefined, undefined, {
		mode: "json",
		ui: {
			notify: (message: string) => notices.push(message),
			input: async () => { throw new Error("plain input should not be used"); },
		},
	});

	expect(notices).toEqual(["Secret questions require interactive TUI mode."]);
	expect(result.content[0].text).toBe("Questionnaire interrupted");
	expect(result.details.answers).toEqual([{ id: "token", question: "API token?", cancelled: true, secret: true }]);
	expect(JSON.stringify(result)).not.toContain("actual-secret");
});
