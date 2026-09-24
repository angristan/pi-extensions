import { afterEach, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import questions from "./index";

initTheme();

type BusHandler = (event: unknown) => unknown | Promise<unknown>;
const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
});

function registeredTool(
	events: Array<{ name: string; payload: any }> = [],
	busHandlers: Record<string, BusHandler[]> = {},
	lifecycleHandlers: Record<string, BusHandler[]> = {},
) {
	let tool: any;
	questions({
		getSessionName: () => "Current session",
		registerTool: (definition: any) => { tool = definition; },
		on(name: string, handler: BusHandler) {
			(lifecycleHandlers[name] ??= []).push(handler);
		},
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
	shutdowns.push(async () => {
		for (const handler of lifecycleHandlers.session_shutdown ?? []) await handler({});
	});
	return tool;
}

function emitBus(busHandlers: Record<string, BusHandler[]>, name: string, payload: unknown): void {
	for (const handler of busHandlers[name] ?? []) handler(payload);
}

test("keeps the session name in the pending title", async () => {
	const events: Array<{ name: string; payload: any }> = [];
	const tool = registeredTool(events);
	const rendered: string[][] = [];
	const titles: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, ctx.ui.theme, getKeybindings(), resolve);
				rendered.push(component.render(50));
				if (rendered.length === 1) { component.handleInput("\x1b[B"); component.handleInput("\r"); }
				else { for (const char of "Because it is calm") component.handleInput(char); component.handleInput("\r"); }
			}),
			setTitle: (title: string) => titles.push(title),
		},
	};
	const result = await tool.execute("id", { questions: [
		{ id: "color", question: "Pick a color", options: ["Red", "Blue"], allow_other: false },
		{ id: "why", question: "Why?", allow_other: false },
	] }, undefined, undefined, ctx);

	expect(rendered[0].map((line) => line.trimEnd()).join("\n")).toContain("Question 1/2\n Pick a color");
	expect(rendered[0].map((line) => line.trimEnd()).join("\n")).toContain(" ▌ Red\n\n ○ Blue");
	expect(rendered[1].map((line) => line.trimEnd()).join("\n")).toContain("Question 2/2\n Why?");
	expect(rendered.flat().every((line) => !line || line.startsWith(" "))).toBe(true);
	for (const dialog of rendered) {
		expect(dialog.at(-2)).toContain("Esc cancel");
		expect(dialog.at(-1)?.trim()).toBe("");
		const hint = dialog.findIndex((line) => line.includes("Esc cancel"));
		expect(dialog[hint - 1].trim()).toBe("");
	}
	expect(titles).toEqual(["❓ Current session", "Current session"]);
	expect(events).toEqual([
		{ name: "terminal-title:override", payload: { source: "questions", title: "❓ Current session" } },
		{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user input" } },
		{ name: "questions:waiting", payload: { requestId: "id:0", questionnaireId: "id", question: "Pick a color", options: ["Red", "Blue"], allowOther: false, index: 1, total: 2, secret: false } },
		{ name: "herdr:blocked", payload: { active: false } },
		{ name: "questions:resolved", payload: { requestId: "id:0", questionnaireId: "id", index: 1, total: 2, outcome: "answered", source: "tui" } },
		{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user input" } },
		{ name: "questions:waiting", payload: { requestId: "id:1", questionnaireId: "id", question: "Why?", options: [], allowOther: false, index: 2, total: 2, secret: false } },
		{ name: "herdr:blocked", payload: { active: false } },
		{ name: "questions:resolved", payload: { requestId: "id:1", questionnaireId: "id", index: 2, total: 2, outcome: "answered", source: "tui" } },
		{ name: "terminal-title:override", payload: { source: "questions", title: undefined } },
	]);
	expect(result.content[0].text).toBe("color: Blue\nwhy: Because it is calm");
	expect(result.details.interrupted).toBe(false);
	expect(result.details.answers).toHaveLength(2);
});

test("renders multi-line Markdown in questions and options without changing the answer", async () => {
	const tool = registeredTool();
	const option = "**Fast**\n\n- Sends two requests";
	let display: string[] = [];
	let narrow: string[] = [];
	let moved: string[] = [];
	const background = "\x1b[48;2;58;58;74m";
	const panelBackground = "\x1b[48;2;45;40;56m";
	const accent = "\x1b[38;2;138;190;183m";
	const theme = {
		fg: (color: string, text: string) => color === "accent" ? `${accent}${text}\x1b[39m` : text,
		bold: (text: string) => text,
		bg: (color: string, text: string) => {
			expect(["selectedBg", "customMessageBg"]).toContain(color);
			return `${color === "selectedBg" ? background : panelBackground}${text}\x1b[49m`;
		},
	};
	const result = await tool.execute("md", { questions: [
		{ id: "mode", question: "Choose a **mode**\n\nSee `config`.", options: [option, "*Slow*"], allow_other: false },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme,
			setTitle() {},
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, theme, getKeybindings(), resolve);
				display = component.render(40);
				narrow = component.render(12);
				component.handleInput("\x1b[B");
				moved = component.render(40);
				component.handleInput("\x1b[A");
				component.handleInput("\r");
			}),
		},
	});

	const plain = display.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	expect(plain).toContain("Choose a mode");
	expect(plain).toContain("See config.");
	expect(plain).toContain("Fast");
	expect(plain).toContain("Sends two requests");
	expect(plain).not.toContain("**");
	const lines = plain.split("\n").map((line) => line.trimEnd());
	const secondChoice = lines.findIndex((line) => line === " ○ Slow");
	expect(secondChoice).toBeGreaterThan(0);
	expect(lines[secondChoice - 1]).toBe("");
	expect(lines[secondChoice - 2]).toContain("Sends two requests");
	const firstChoice = lines.findIndex((line) => line.startsWith(" ▌ Fast"));
	expect(firstChoice).toBeGreaterThan(0);
	expect(display.slice(firstChoice, secondChoice - 1).every((line) => line.startsWith(`${panelBackground} \x1b[49m${background}`) && visibleWidth(line) === 40 && line.includes(`${accent}▌ `))).toBe(true);
	expect(display[secondChoice]).not.toContain(background);
	expect(display[secondChoice]).not.toContain("▌");
	expect(moved.find((line) => line.includes("○ Fast"))).not.toContain(background);
	expect(moved.find((line) => line.includes("▌") && line.includes("Slow"))).toContain(background);
	expect(display.every((line) => line.startsWith(panelBackground) && visibleWidth(line) === 40)).toBe(true);
	expect(narrow.every((line) => line.startsWith(panelBackground) && visibleWidth(line) <= 12)).toBe(true);
	expect(lines[lines.findIndex((line) => line.includes("↑/↓ select")) - 1]).toBe("");
	expect(display.at(-1)).toBe(`${panelBackground}${" ".repeat(40)}\x1b[49m`);
	expect(result.details.answers[0].answer).toBe(option);
});

test("keeps the chosen Markdown option highlighted after answering", () => {
	const tool = registeredTool();
	const question = "## Markdown demo\n\nChoose a **format** with `code`.";
	const answer = "**Compact**\n\n- One short answer\n- Minimal detail";
	const selectedBg = "\x1b[48;2;58;58;74m";
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (color: string, text: string) => `${color === "selectedBg" ? selectedBg : "\x1b[48;2;45;40;56m"}${text}\x1b[49m`,
	};
	const component = tool.renderResult({ details: {
		questions: [{ id: "format", question, options: [answer, "*Detailed*"] }],
		answers: [{ id: "format", question, answer }],
		interrupted: false,
	} }, {}, theme);
	const lines = component.render(55);
	const plain = lines.map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");

	expect(plain).toContain("Markdown demo");
	expect(plain).toContain("Choose a format with code.");
	expect(plain).toContain("Question 1/1");
	expect(plain).toContain(" ▌ Compact");
	expect(plain).toContain(" ○ Detailed");
	expect(plain).toContain("One short answer");
	expect(plain).not.toContain("↑/↓ select");
	expect(component.handleInput).toBeUndefined();
	expect(plain).not.toMatch(/\*\*|##|`/);
	expect(lines.find((line: string) => line.includes("Compact"))).toContain(selectedBg);
	expect(lines.find((line: string) => line.includes("Detailed"))).not.toContain(selectedBg);
	for (const width of [1, 5, 24]) {
		expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
	}
});

test("highlights remote choices and displays custom answers as choices", () => {
	const tool = registeredTool();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (_color: string, text: string) => text,
	};
	const render = (answer: string) => {
		const component = tool.renderResult({ details: {
			questions: [{ id: "mode", question: "Pick a **mode**", options: ["**Fast**", "*Slow*"] }],
			answers: [{ id: "mode", question: "Pick a **mode**", answer }],
			interrupted: false,
		} }, {}, theme);
		return component.render(60).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
	};

	expect(render("*Slow*")).toContain(" ○ Fast\n\n ▌ Slow");
	expect(render("Custom **mode**")).toContain(" ○ Slow\n\n ▌ Custom mode");
	const freeText = tool.renderResult({ details: {
		questions: [{ id: "reply", question: "Your reply?" }],
		answers: [{ id: "reply", question: "Your reply?", answer: "**Custom** reply" }],
		interrupted: false,
	} }, {}, theme);
	expect(freeText.render(60).some((line: string) => line.includes("▌") && line.includes("Custom"))).toBe(true);
	const options = Array.from({ length: 8 }, (_, index) => `Choice ${index + 1}`);
	const longList = tool.renderResult({ details: {
		questions: [{ id: "many", question: "Pick one", options }],
		answers: [{ id: "many", question: "Pick one", answer: options[7] }],
		interrupted: false,
	} }, {}, theme);
	expect(longList.render(60).some((line: string) => line.includes("▌") && line.includes("Choice 8"))).toBe(true);
});

test("masks secret answers and shows unanswered questions in the recap", () => {
	const tool = registeredTool();
	const component = tool.renderResult({ details: {
		questions: [
			{ id: "token", question: "Enter the **token**", secret: true },
			{ id: "later", question: "Try *later*?" },
		],
		answers: [{ id: "token", question: "Enter the **token**", reference: "{{questionnaire-secret:opaque}}", provided: true, secret: true }],
		interrupted: true,
	} }, {}, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
	const plain = component.render(55).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

	expect(plain).toContain("Questions 1/2 answered (interrupted)");
	expect(plain).toContain("Enter the token");
	expect(plain).toContain("••••••");
	expect(plain).toContain("(unanswered)");
	expect(plain).not.toContain("questionnaire-secret");
	expect(plain).not.toContain("**");
	expect(component.render(5).every((line: string) => visibleWidth(line) <= 5)).toBe(true);
});

test("keeps a literal free-text label distinct from the free-text action", async () => {
	const tool = registeredTool();
	const result = await tool.execute("choice", { questions: [
		{ id: "answer", question: "Pick one", options: ["Type something…"] },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, {}, getKeybindings(), resolve);
				component.handleInput("\r");
			}),
		},
	});
	expect(result.details.answers[0].answer).toBe("Type something…");
});

test("accepts a typed answer after the Markdown choice list", async () => {
	const tool = registeredTool();
	let dialogs = 0;
	const result = await tool.execute("other", { questions: [
		{ id: "mode", question: "Choose a **mode**", options: ["*Fast*"] },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), resolve);
				if (++dialogs === 1) component.handleInput("\x1b[B");
				else {
					expect(component.render(40).join("\n")).toContain("Choose a mode");
					for (const char of "Custom") component.handleInput(char);
				}
				component.handleInput("\r");
			}),
		},
	});
	expect(dialogs).toBe(2);
	expect(result.details.answers[0].answer).toBe("Custom");
});

test("renders the free-text question and masks secret input", async () => {
	const tool = registeredTool();
	const views: string[][] = [];
	const panelBackground = "\x1b[48;2;45;40;56m";
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (color: string, text: string) => {
			expect(color).toBe("customMessageBg");
			return `${panelBackground}${text}\x1b[49m`;
		},
	};
	const result = await tool.execute("secret-md", { questions: [
		{ id: "token", question: "Enter the **token**", secret: true },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme,
			setTitle() {},
			custom: async (factory: any) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, theme, getKeybindings(), resolve);
				component.focused = true;
				views.push(component.render(35));
				for (const char of "hidden-token") component.handleInput(char);
				views.push(component.render(35));
				component.handleInput("\r");
			}),
		},
	});
	expect(views[0].join("\n")).toContain("Enter the token");
	expect(views.flat().every((line) => line.startsWith(panelBackground) && visibleWidth(line) === 35)).toBe(true);
	expect(views[0].at(-2)).toContain("Esc cancel");
	expect(views[0].at(-1)?.replace(/\x1b\[[0-9;]*m/g, "").trim()).toBe("");
	const hint = views[0].findIndex((line) => line.includes("Esc cancel"));
	expect(views[0][hint - 1].replace(/\x1b\[[0-9;]*m/g, "").trim()).toBe("");
	expect(views[1].join("\n")).not.toContain("hidden-token");
	expect(views[1].join("\n")).toContain("••••");
	expect(JSON.stringify(result)).not.toContain("hidden-token");
});

test("skips the local dialog when an answer arrives immediately", async () => {
	const handlers: Record<string, BusHandler[]> = {};
	const tool = registeredTool([], handlers);
	handlers["questions:waiting"] = [() => emitBus(handlers, "questions:answer", { requestId: "early:0", answer: "production" })];
	const result = await tool.execute("early", { questions: [
		{ id: "target", question: "Choose **target**", options: ["production"] },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			custom: () => { throw new Error("local dialog must not open"); },
		},
	});
	expect(result.details.answers[0].answer).toBe("production");
});

test("reports Herdr blocked state only while user input is pending", async () => {
	const events: Array<{ name: string; payload: any }> = [];
	const tool = registeredTool(events);
	let answer!: (value: string | undefined) => void;
	const execution = tool.execute("pending", { questions: [
		{ id: "proceed", question: "Proceed?", allow_other: false },
	] }, undefined, undefined, {
		mode: "json",
		ui: {
			input: async () => new Promise<string | undefined>((resolve) => { answer = resolve; }),
		},
	});
	await Promise.resolve();

	expect(events.filter((event) => event.name === "herdr:blocked")).toEqual([
		{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user input" } },
	]);

	answer("yes");
	await execution;
	expect(events.filter((event) => event.name === "herdr:blocked")).toEqual([
		{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user input" } },
		{ name: "herdr:blocked", payload: { active: false } },
	]);
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
		{ name: "herdr:blocked", payload: { active: true, label: "Waiting for user input" } },
		{ name: "questions:waiting", payload: { requestId: "id:0", questionnaireId: "id", question: "API token?", options: [], allowOther: false, index: 1, total: 2, secret: true } },
		{ name: "herdr:blocked", payload: { active: false } },
		{ name: "questions:resolved", payload: { requestId: "id:0", questionnaireId: "id", index: 1, total: 2, outcome: "cancelled", source: "tui" } },
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
			custom: async (factory: any) => new Promise((resolve) => {
				factory({ requestRender() {} }, {}, getKeybindings(), (answer: unknown) => { dialogAborted = true; resolve(answer); });
			}),
		},
	});
	await Promise.resolve();

	emitBus(busHandlers, "questions:answer", { requestId: "remote:0", answer: "production" });
	const result = await execution;

	expect(dialogAborted).toBe(true);
	expect(result.content[0].text).toBe("target: production");
	expect(result.details.interrupted).toBe(false);
	expect(events).toContainEqual({
		name: "questions:resolved",
		payload: { requestId: "remote:0", questionnaireId: "remote", index: 1, total: 1, outcome: "answered", source: "remote" },
	});
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

	expect(result.content[0].text).toMatch(/^token: \{\{questionnaire-secret:[0-9a-f-]{36}\}\}$/);
	expect(JSON.stringify(result)).not.toContain("stolen");
	expect(JSON.stringify(result)).not.toContain("real-secret");
});

test("substitutes secret references only for tool execution", async () => {
	const lifecycleHandlers: Record<string, BusHandler[]> = {};
	const tool = registeredTool([], {}, lifecycleHandlers);
	const result = await tool.execute("secret", { questions: [
		{ id: "token", question: "API token?", secret: true, allow_other: false },
	] }, undefined, undefined, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setTitle() {},
			custom: async () => "actual-secret",
		},
	});
	const reference = result.details.answers[0].reference;
	const input = { command: `curl -H 'X-API-Key: ${reference}' https://example.test` };

	for (const handler of lifecycleHandlers.tool_call ?? []) await handler({ toolName: "bash", input });

	expect(input.command).toBe("curl -H 'X-API-Key: actual-secret' https://example.test");
	expect(JSON.stringify(result)).not.toContain("actual-secret");

	let output = { content: [{ type: "text", text: "Rejected actual-secret" }], details: { request: { token: "actual-secret" } } };
	for (const handler of lifecycleHandlers.tool_result ?? []) output = await handler(output) as typeof output;
	expect(output).toEqual({ content: [{ type: "text", text: "Rejected [redacted]" }], details: { request: { token: "[redacted]" } } });

	for (const handler of lifecycleHandlers.session_shutdown ?? []) await handler({});
	const staleInput = { command: `echo ${reference}` };
	const resolutions = [];
	for (const handler of lifecycleHandlers.tool_call ?? []) resolutions.push(await handler({ toolName: "bash", input: staleInput }));
	expect(resolutions).toContainEqual({ block: true, reason: "A questionnaire secret reference expired. Ask the user for the secret again." });
	expect(staleInput.command).toBe(`echo ${reference}`);
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
			custom: async (factory: any) => new Promise((resolve) => {
				factory({ requestRender() {} }, {}, getKeybindings(), resolve);
			}),
		},
	});
	await Promise.resolve();

	emitBus(busHandlers, "questions:answer", { requestId: "strict:0", answer: "elsewhere" });
	await Promise.resolve();
	emitBus(busHandlers, "questions:answer", { requestId: "strict:0", answer: "staging" });
	const result = await execution;

	expect(result.content[0].text).toBe("target: staging");
});
