import { expect, mock, test } from "bun:test";

mock.module("../overlay-stack/index.js", () => ({
	registerOverlayCard: () => ({ invalidate() {}, unregister() {} }),
}));

const { default: planProgress } = await import("./index");

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
};

function createHarness(branch: any[] = []) {
	const tools: any[] = [];
	const handlers: Record<string, any[]> = {};
	const commands: Record<string, any> = {};
	const appended: Array<{ customType: string; data: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	planProgress({
		appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
		events: { emit() {}, on() {} },
		on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
		registerCommand(name: string, command: any) { commands[name] = command; },
		registerTool(tool: any) { tools.push(tool); },
	} as any);
	const ctx = {
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
		},
		ui: {
			theme,
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus() {},
			setWidget() {},
		},
	};
	return {
		appended,
		commands,
		ctx,
		handlers,
		notifications,
		updatePlan: tools.find((tool) => tool.name === "update_plan"),
	};
}

const renderHarness = createHarness();
const { handlers, updatePlan } = renderHarness;

test("does not rebuild the system prompt from mutable plan state", () => {
	expect(handlers.before_agent_start).toBeUndefined();
});

test("wrapped plan result lines retain their left padding", () => {
	const component = updatePlan.renderResult({
		details: {
			explanation: "Alpha beta gamma delta",
			items: [{ step: "Do more work now", status: "in_progress" }],
		},
	}, {}, theme);

	expect(component.render(18)).toEqual([
		"• Updated Plan",
		"  Alpha beta gamma",
		"  delta",
		"  └ ● Do more work",
		"      now",
	]);
});

test("terminates ANSI styles before overlay compositor padding", () => {
	const ansiTheme = {
		...theme,
		fg: (_color: string, text: string) => `\x1b[38m${text}\x1b[39m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	};
	const component = updatePlan.renderResult({
		details: { items: [{ step: "Completed step", status: "completed" }] },
	}, {}, ansiTheme);

	const completedLine = component.render(80)[1];
	expect(completedLine).toContain("\x1b[29m");
	expect(completedLine).toEndWith("\x1b[0m ");
});

test("malformed plan result details render as an empty plan", () => {
	const component = updatePlan.renderResult({ details: {} }, {}, theme);

	expect(component.render(18)).toEqual([
		"• Updated Plan",
		"  └ (no steps)",
	]);
});

async function executePlan(harness: ReturnType<typeof createHarness>, params: any) {
	return harness.updatePlan.execute(
		"tool-call",
		params,
		new AbortController().signal,
		undefined,
		harness.ctx,
	);
}

test("accepts, normalizes, and persists a valid plan update", async () => {
	const harness = createHarness();
	const result = await executePlan(harness, {
		explanation: "  Starting implementation  ",
		plan: [
			{ step: "  Inspect code  ", status: "completed" },
			{ step: "Add tests", status: "in_progress" },
			{ step: "Run checks", status: "pending" },
		],
	});

	const expected = {
		explanation: "Starting implementation",
		items: [
			{ step: "Inspect code", status: "completed" },
			{ step: "Add tests", status: "in_progress" },
			{ step: "Run checks", status: "pending" },
		],
	};
	expect(result.details).toEqual(expected);
	expect(harness.appended).toEqual([{ customType: "plan-progress", data: expected }]);
	expect(result.content[0].text).toContain("Current step: Add tests");
});

test("rejects plans with more than one in-progress step without persisting", async () => {
	const harness = createHarness();

	await expect(executePlan(harness, {
		plan: [
			{ step: "First", status: "in_progress" },
			{ step: "Second", status: "in_progress" },
		],
	})).rejects.toThrow("only one plan step may be in_progress");
	expect(harness.appended).toEqual([]);
});

test("rejects unfinished plans without an active step or inactive-work explanation", async () => {
	const harness = createHarness();

	await expect(executePlan(harness, {
		plan: [
			{ step: "Finished", status: "completed" },
			{ step: "Still open", status: "pending" },
		],
	})).rejects.toThrow("unfinished plans must have exactly one in_progress step");
	expect(harness.appended).toEqual([]);
});

for (const [reason, explanation] of [
	["blocked", "Blocked by an upstream dependency"],
	["deferred", "Remaining work is deferred until approval"],
] as const) {
	test(`accepts an unfinished inactive plan when explained as ${reason}`, async () => {
		const harness = createHarness();
		const result = await executePlan(harness, {
			explanation,
			plan: [{ step: "Wait for follow-up", status: "pending" }],
		});

		expect(result.details.explanation).toBe(explanation);
		expect(harness.appended).toHaveLength(1);
	});
}

for (const [label, payload, expectedField] of [
	["top-level", { plan: [], surprise: true }, "unknown top-level field(s): surprise"],
	["step", { plan: [{ step: "Done", status: "completed", surprise: true }] }, "unknown step 1 field(s): surprise"],
] as const) {
	test(`rejects unknown ${label} keys`, async () => {
		const harness = createHarness();

		await expect(executePlan(harness, payload)).rejects.toThrow(expectedField);
		expect(harness.appended).toEqual([]);
	});
}

test("restores the latest plan state from the active session branch", async () => {
	const harness = createHarness([
		{ type: "custom", customType: "plan-progress", data: { items: [{ step: "Old step", status: "completed" }] } },
		{ type: "custom", customType: "other-extension", data: { items: [] } },
		{
			type: "custom",
			customType: "plan-progress",
			data: {
				explanation: "Restored state",
				items: [
					{ step: "Restored done", status: "completed" },
					{ step: "Restored active", status: "in_progress" },
				],
			},
		},
	]);

	await harness.handlers.session_start[0]({}, harness.ctx);
	await harness.commands["plan-status"].handler("", harness.ctx);

	expect(harness.notifications).toEqual([{
		level: "info",
		message: "• Updated Plan\n  Restored state\n  └ ✓ Restored done\n  └ ● Restored active",
	}]);
});
