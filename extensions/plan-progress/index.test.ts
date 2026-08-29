import { expect, test } from "bun:test";
import planProgress from "./index";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
};
const ansiTheme = {
	...theme,
	fg: (_color: string, text: string) => `\x1b[38m${text}\x1b[39m`,
	strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
};

function createHarness(branch: any[] = []) {
	const tools: any[] = [];
	const handlers: Record<string, any[]> = {};
	const commands: Record<string, any> = {};
	const appended: Array<{ customType: string; data: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let overlayCardDefinition: any;
	planProgress({
		appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
		events: { emit() {}, on() {} },
		on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
		registerCommand(name: string, command: any) { commands[name] = command; },
		registerTool(tool: any) { tools.push(tool); },
	} as any, {
		registerOverlayCard: (definition: any) => {
			overlayCardDefinition = definition;
			return { invalidate() {}, unregister() {} };
		},
	});
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
		overlayCardDefinition,
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
		"  └─ ● Do more",
		"       work now",
	]);
});

test("terminates ANSI styles before overlay compositor padding", () => {
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
		"  └─ (no steps)",
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

test("terminates completed-task styles before overlay card padding", async () => {
	const harness = createHarness();
	await executePlan(harness, {
		plan: [{ step: "Completed step", status: "completed" }],
	});

	const completedLine = harness.overlayCardDefinition.renderBody(46, 20, ansiTheme)[0];
	expect(completedLine).toContain("\x1b[29m");
	expect(completedLine).toEndWith("\x1b[0m ");
});

test("narrows the overlay without reducing vertical detail", async () => {
	const harness = createHarness();
	await executePlan(harness, {
		explanation: "This deliberately long explanation may use multiple rows because only horizontal space should be reduced.",
		plan: Array.from({ length: 9 }, (_, index) => ({
			step: `Task ${index + 1}`,
			status: index === 0 ? "in_progress" : "pending",
		})),
	});

	const rows = harness.overlayCardDefinition.renderBody(46, 30, theme);
	expect(harness.overlayCardDefinition.width).toBe(50);
	expect(rows.length).toBeGreaterThan(7);
	expect(rows).toContain("");
	expect(rows.some((line: string) => line.includes("Task 9"))).toBe(true);
	expect(rows.join("\n")).not.toContain("/plan-status for full list");
});

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

test("derives nested group progress and collapses inactive groups in the overlay", async () => {
	const harness = createHarness();
	const result = await executePlan(harness, {
		plan: [
			{ step: "Implementation", status: "completed" },
			{ step: "Backend", depth: 1 },
			{ step: "Ship API", status: "completed", depth: 2 },
			{ step: "Run invariants", status: "in_progress", depth: 2 },
			{ step: "Write docs", status: "pending", depth: 1 },
			{ step: "Release" },
			{ step: "Publish", status: "pending", depth: 1 },
		],
	});

	expect(result.details.items).toEqual([
		{ step: "Implementation", status: "in_progress" },
		{ step: "Backend", status: "in_progress", depth: 1 },
		{ step: "Ship API", status: "completed", depth: 2 },
		{ step: "Run invariants", status: "in_progress", depth: 2 },
		{ step: "Write docs", status: "pending", depth: 1 },
		{ step: "Release", status: "pending" },
		{ step: "Publish", status: "pending", depth: 1 },
	]);
	expect(result.content[0].text).toContain("Plan updated: 1/4 tasks completed.");
	expect(result.content[0].text).toContain("Current step: Implementation › Backend › Run invariants");
	expect(result.content[0].text).toContain("- [>] Implementation (1/3)");

	expect(harness.overlayCardDefinition.title(theme)).toBe(" Plan 1/4 ");
	const overlayRows = harness.overlayCardDefinition.renderBody(80, 20, theme);
	const overlay = overlayRows.join("\n");
	expect(overlayRows.find((line: string) => line.includes("Implementation"))).toStartWith("├─ ");
	expect(overlayRows.find((line: string) => line.includes("Backend"))).toStartWith("│  ├─ ");
	expect(overlay).toContain("◆ Implementation · 1/3");
	expect(overlay).toContain("◆ Backend · 1/2");
	expect(overlay).toContain("◇ Release · 0/1");
	expect(overlay).not.toContain("Publish");

	await harness.commands["plan-status"].handler("", harness.ctx);
	expect(harness.notifications.at(-1)?.message).toBe([
		"• Updated Plan",
		"  ├─ ◆ Implementation · 1/3",
		"  │  ├─ ◆ Backend · 1/2",
		"  │  │  ├─ ✓ Ship API",
		"  │  │  └─ ● Run invariants",
		"  │  └─ ○ Write docs",
		"  └─ ◇ Release · 0/1",
		"     └─ ○ Publish",
	].join("\n"));
});

test("rejects invalid nesting and missing leaf statuses", async () => {
	const harness = createHarness();

	await expect(executePlan(harness, {
		plan: [
			{ step: "Group" },
			{ step: "Too deep", status: "in_progress", depth: 2 },
		],
	})).rejects.toThrow("depth may increase by at most one");
	await expect(executePlan(harness, {
		plan: [{ step: "Leaf without status" }],
	})).rejects.toThrow("leaf tasks require a status");
	expect(harness.appended).toEqual([]);
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
		message: "• Updated Plan\n  Restored state\n  ├─ ✓ Restored done\n  └─ ● Restored active",
	}]);
});
