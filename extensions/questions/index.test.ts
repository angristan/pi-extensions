import { expect, test } from "bun:test";
import questions from "./index";

type BusHandler = (event: unknown) => void;

function registeredTool(
	events: Array<{ name: string; payload: any }> = [],
	busHandlers: Record<string, BusHandler[]> = {},
) {
	let tool: any;
	questions({
		registerTool: (definition: any) => { tool = definition; },
		events: {
			emit(name: string, payload: any) {
				events.push({ name, payload });
				for (const handler of busHandlers[name] ?? []) handler(payload);
			},
			on(name: string, handler: BusHandler) {
				(busHandlers[name] ??= []).push(handler);
				return () => { busHandlers[name] = (busHandlers[name] ?? []).filter((candidate) => candidate !== handler); };
			},
		},
	} as any);
	return tool;
}

function emitBus(busHandlers: Record<string, BusHandler[]>, name: string, payload: unknown): void {
	for (const handler of busHandlers[name] ?? []) handler(payload);
}

test("collects answers with numbered, semantically colored prompts", async () => {
	const events: Array<{ name: string; payload: any }> = [];
	const tool = registeredTool(events);
	const selected: string[] = [];
	const prompts: string[] = [];
	const titles: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: {
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				bold: (text: string) => `<b>${text}</b>`,
			},
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
	expect(prompts).toEqual([
		"<accent><b>Question 1/2</b></accent><dim> · </dim><text>Pick a color</text>",
		"<accent><b>Question 2/2</b></accent><dim> · </dim><text>Why?</text>",
	]);
	expect(titles).toEqual(["❓ Input needed · Question 1/2", "❓ Input needed · Question 2/2", "pi"]);
	expect(events).toEqual([
		{ name: "terminal-title:override", payload: { source: "questions", title: "❓ Input needed · Question 1/2" } },
		{ name: "questions:waiting", payload: { requestId: "id:0", question: "Pick a color", options: ["Red", "Blue"], allowOther: false, index: 1, total: 2, secret: false } },
		{ name: "questions:resolved", payload: { requestId: "id:0" } },
		{ name: "terminal-title:override", payload: { source: "questions", title: "❓ Input needed · Question 2/2" } },
		{ name: "questions:waiting", payload: { requestId: "id:1", question: "Why?", options: [], allowOther: false, index: 2, total: 2, secret: false } },
		{ name: "questions:resolved", payload: { requestId: "id:1" } },
		{ name: "terminal-title:override", payload: { source: "questions", title: undefined } },
	]);
	expect(result.content[0].text).toBe("color: Blue\nwhy: Because it is calm");
	expect(result.details.interrupted).toBe(false);
	expect(result.details.answers).toHaveLength(2);
});

test("stops after cancellation and never stores secret text", async () => {
	const events: Array<{ name: string; payload: any }> = [];
	const tool = registeredTool(events);
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
	expect(events).toEqual([
		{ name: "questions:waiting", payload: { requestId: "id:0", question: "API token?", options: [], allowOther: false, index: 1, total: 2, secret: true } },
		{ name: "questions:resolved", payload: { requestId: "id:0" } },
	]);
	expect(JSON.stringify(result)).not.toContain("actual-secret");
});

test("accepts a remote option and dismisses the local selector", async () => {
	const events: Array<{ name: string; payload: any }> = [];
	const busHandlers: Record<string, BusHandler[]> = {};
	const tool = registeredTool(events, busHandlers);
	let dialogAborted = false;
	const execution = tool.execute("remote", { questions: [
		{ id: "target", question: "Deploy where?", options: ["staging", "production"], allow_other: false },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			select: async (_prompt: string, _options: string[], opts: { signal: AbortSignal }) =>
				new Promise<undefined>((resolve) => opts.signal.addEventListener("abort", () => { dialogAborted = true; resolve(undefined); }, { once: true })),
		},
	});
	await Promise.resolve();

	emitBus(busHandlers, "questions:answer", { requestId: "remote:0", answer: "production" });
	const result = await execution;

	expect(dialogAborted).toBe(true);
	expect(result.content[0].text).toBe("target: production");
	expect(result.details.interrupted).toBe(false);
});

test("ignores remote answers for secret prompts", async () => {
	const busHandlers: Record<string, BusHandler[]> = {};
	const tool = registeredTool([], busHandlers);
	let finishSecret!: (answer: string | undefined) => void;
	const execution = tool.execute("secret", { questions: [
		{ id: "token", question: "API token?", secret: true, allow_other: false },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			custom: async () => new Promise<string | undefined>((resolve) => { finishSecret = resolve; }),
		},
	});
	await Promise.resolve();

	emitBus(busHandlers, "questions:answer", { requestId: "secret:0", answer: "stolen" });
	await Promise.resolve();
	finishSecret("real-secret");
	const result = await execution;

	expect(result.content[0].text).toBe("token: [secret provided]");
	expect(JSON.stringify(result)).not.toContain("stolen");
	expect(JSON.stringify(result)).not.toContain("real-secret");
});

test("ignores invalid remote choices until an allowed answer arrives", async () => {
	const busHandlers: Record<string, BusHandler[]> = {};
	const tool = registeredTool([], busHandlers);
	const execution = tool.execute("strict", { questions: [
		{ id: "target", question: "Deploy where?", options: ["staging", "production"], allow_other: false },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			select: async (_prompt: string, _options: string[], opts: { signal: AbortSignal }) =>
				new Promise<undefined>((resolve) => opts.signal.addEventListener("abort", () => resolve(undefined), { once: true })),
		},
	});
	await Promise.resolve();

	emitBus(busHandlers, "questions:answer", { requestId: "strict:0", answer: "elsewhere" });
	await Promise.resolve();
	emitBus(busHandlers, "questions:answer", { requestId: "strict:0", answer: "staging" });
	const result = await execution;

	expect(result.content[0].text).toBe("target: staging");
});
