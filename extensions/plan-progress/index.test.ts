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
	const sentMessages: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let overlayCardDefinition: any;
	planProgress({
		appendEntry(customType: string, data: any) { appended.push({ customType, data }); },
		sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
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
		sentMessages,
		updatePlan: tools.find((tool) => tool.name === "update_plan"),
	};
}

const renderHarness = createHarness();
const { handlers, updatePlan } = renderHarness;

test("does not rebuild the system prompt from mutable plan state", () => {
	expect(handlers.before_agent_start).toBeUndefined();
});

test("does not render legacy update explanations as plan content", () => {
	const component = updatePlan.renderResult({
		details: {
			explanation: "Alpha beta gamma delta",
			items: [{ step: "Do more work now", status: "in_progress" }],
		},
	}, {}, theme);

	expect(component.render(18)).toEqual([
		"• Updated Plan",
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
		reason: "The objective changed.",
		plan: Array.from({ length: 9 }, (_, index) => ({
			step: `Task ${index + 1}`,
			status: index === 0 ? "in_progress" : "pending",
		})),
	});

	const rows = harness.overlayCardDefinition.renderBody(46, 30, theme);
	expect(harness.overlayCardDefinition.width).toBe(50);
	expect(rows.length).toBeGreaterThan(7);
	expect(rows.some((line: string) => line.includes("The objective changed"))).toBe(false);
	expect(rows.some((line: string) => line.includes("Task 9"))).toBe(true);
	expect(rows.join("\n")).not.toContain("/plan-status for full list");
});

test("accepts, normalizes, and persists a valid plan update", async () => {
	const harness = createHarness();
	const result = await executePlan(harness, {
		reason: "  Starting implementation  ",
		plan: [
			{ step: "  Inspect code  ", status: "completed" },
			{ step: "Add tests", description: "  Cover description\n behavior  ", status: "in_progress" },
			{ step: "Run checks", status: "pending" },
		],
	});

	const expected = {
		items: [
			{ step: "Inspect code", status: "completed" },
			{ step: "Add tests", description: "Cover description behavior", status: "in_progress" },
			{ step: "Run checks", status: "pending" },
		],
	};
	expect(result.details).toEqual(expected);
	expect(harness.appended).toEqual([{ customType: "plan-progress", data: expected }]);
	expect(result.content[0].text).toContain("Current step: Add tests");
	expect(result.content[0].text).toContain("Description: Cover description behavior");
	expect(result.content[0].text).not.toContain("Starting implementation");
});

test("maps legacy explanations to hidden update reasons", async () => {
	const harness = createHarness();
	const prepared = harness.updatePlan.prepareArguments({
		explanation: "The objective changed.",
		reset: true,
		plan: [{ step: "Handle the new objective", status: "in_progress" }],
	});

	expect(prepared).toEqual({
		reason: "The objective changed.",
		reset: true,
		plan: [{ step: "Handle the new objective", status: "in_progress" }],
	});
	const result = await executePlan(harness, prepared);
	expect(result.details).toEqual({ items: [{ step: "Handle the new objective", status: "in_progress" }] });
	expect(result.content[0].text).not.toContain("The objective changed");
});

test("keeps descriptions compact in the overlay and transcript", async () => {
	const harness = createHarness();
	const result = await executePlan(harness, {
		plan: [
			{ step: "Inspect code", description: "Find the relevant state and rendering paths.", status: "completed" },
			{
				step: "Add tests",
				description: "Run integration tests and compare the complete output before closing this task.",
				status: "in_progress",
			},
			{ step: "Run checks", description: "Execute the full repository validation.", status: "pending" },
		],
	});

	const compact = harness.updatePlan.renderResult(result, { expanded: false }, theme).render(40).join("\n");
	expect(compact).not.toContain("Find the relevant state");
	expect(compact).not.toContain("Run integration tests");

	const expanded = harness.updatePlan.renderResult(result, { expanded: true }, theme).render(40).join("\n");
	expect(expanded).toContain("Find the relevant state");
	expect(expanded).toContain("Run integration tests");
	expect(expanded).toContain("Execute the full repository");

	const overlay = harness.overlayCardDefinition.renderBody(30, 20, theme);
	expect(overlay.join("\n")).not.toContain("Find the relevant state");
	expect(overlay.join("\n")).toContain("Run integration tests");
	expect(overlay.join("\n")).not.toContain("Execute the full repository");
	const activeRow = overlay.findIndex((line: string) => line.includes("Add tests"));
	const nextTaskRow = overlay.findIndex((line: string) => line.includes("Run checks"));
	expect(nextTaskRow - activeRow).toBe(3);
	expect(overlay.some((line: string) => line.endsWith("…"))).toBe(true);

	await harness.commands["plan-status"].handler("", harness.ctx);
	const fullStatus = harness.notifications.at(-1)?.message ?? "";
	expect(fullStatus).toContain("Find the relevant state");
	expect(fullStatus).toContain("Run integration tests");
	expect(fullStatus).toContain("Execute the full repository");
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

test("publishes and enforces the description length limit", async () => {
	const harness = createHarness();
	expect(harness.updatePlan.parameters.properties.reason.description).toContain("not shown in the plan");
	expect(harness.updatePlan.parameters.properties.explanation).toBeUndefined();
	const descriptionSchema = harness.updatePlan.parameters.properties.plan.items.properties.description;
	expect(descriptionSchema.maxLength).toBe(500);

	await expect(executePlan(harness, {
		plan: [{ step: "Invalid description", description: 42, status: "completed" }],
	})).rejects.toThrow("expected a string");
	await expect(executePlan(harness, {
		plan: [{ step: "Long description", description: "x".repeat(501), status: "completed" }],
	})).rejects.toThrow("must be at most 500 characters");
	expect(harness.appended).toEqual([]);
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

test("preserves completed milestones unless an objective reset is explicit", async () => {
	const harness = createHarness();
	await executePlan(harness, {
		plan: [
			{ step: "Map existing behavior", status: "completed" },
			{ step: "Implement the fix", status: "in_progress" },
		],
	});

	await expect(executePlan(harness, {
		plan: [{ step: "Debug the immediate failure", status: "in_progress" }],
	})).rejects.toThrow("cannot remove completed step(s): Map existing behavior");
	await expect(executePlan(harness, {
		reset: true,
		plan: [{ step: "Handle the new objective", status: "in_progress" }],
	})).rejects.toThrow("reset requires a reason");

	const result = await executePlan(harness, {
		reset: true,
		reason: "The latest user request replaced the objective.",
		plan: [{ step: "Handle the new objective", status: "in_progress" }],
	});
	expect(result.details.items).toEqual([{ step: "Handle the new objective", status: "in_progress" }]);
	expect(harness.appended).toHaveLength(2);
});

test("rejects unfinished plans without an active step or inactive-work reason", async () => {
	const harness = createHarness();

	await expect(executePlan(harness, {
		plan: [
			{ step: "Finished", status: "completed" },
			{ step: "Still open", status: "pending" },
		],
	})).rejects.toThrow("unfinished plans must have exactly one in_progress step");
	expect(harness.appended).toEqual([]);
});

for (const [status, reason] of [
	["blocked", "Blocked by an upstream dependency"],
	["deferred", "Remaining work is deferred until approval"],
] as const) {
	test(`accepts an unfinished inactive plan when marked as ${status}`, async () => {
		const harness = createHarness();
		const result = await executePlan(harness, {
			reason,
			plan: [{ step: "Wait for follow-up", status: "pending" }],
		});

		expect(result.details).toEqual({ items: [{ step: "Wait for follow-up", status: "pending" }] });
		expect(result.content[0].text).not.toContain(reason);
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

test("keeps an unfinished plan visible across prompts until cleared", async () => {
	const harness = createHarness();
	await executePlan(harness, {
		plan: [{ step: "Continue work", status: "in_progress" }],
	});

	expect(harness.overlayCardDefinition.visible()).toBe(true);
	await harness.handlers.agent_settled[0]({}, harness.ctx);
	await harness.handlers.input[0]({ source: "interactive" }, harness.ctx);
	expect(harness.overlayCardDefinition.visible()).toBe(true);

	await harness.commands["plan-clear"].handler("", harness.ctx);
	expect(harness.overlayCardDefinition.visible()).toBe(false);
	expect(harness.sentMessages.at(-1)).toEqual({
		message: {
			customType: "plan-progress-context",
			content: "## Execution plan cleared\nThere is no active execution plan. Do not restore an older plan from conversation history or a compaction summary.",
			display: false,
			details: { active: false },
		},
		options: { deliverAs: "steer" },
	});
});

test("clears a completed plan on the next user prompt", async () => {
	const harness = createHarness();
	await executePlan(harness, {
		plan: [{ step: "Finished work", status: "completed" }],
	});

	expect(harness.overlayCardDefinition.visible()).toBe(true);
	await harness.handlers.agent_settled[0]({}, harness.ctx);
	expect(harness.overlayCardDefinition.visible()).toBe(true);

	await harness.handlers.input[0]({ source: "extension" }, harness.ctx);
	expect(harness.overlayCardDefinition.visible()).toBe(true);

	await harness.handlers.input[0]({ source: "interactive" }, harness.ctx);
	expect(harness.overlayCardDefinition.visible()).toBe(false);
	expect(harness.appended.at(-1)).toEqual({ customType: "plan-progress", data: { items: [] } });
});

test("re-anchors the exact plan after compaction and filters stale checkpoints", async () => {
	const harness = createHarness();
	await executePlan(harness, {
		reason: "Keep the full scope",
		plan: [
			{ step: "Map <existing> & behavior", status: "completed" },
			{ step: "Implement the fix", status: "in_progress" },
		],
	});

	await harness.handlers.session_compact[0]({}, harness.ctx);
	const checkpoint = harness.sentMessages.at(-1)!;
	expect(checkpoint.options).toEqual({ deliverAs: "steer" });
	expect(checkpoint.message).toMatchObject({ customType: "plan-progress-context", display: false, details: { active: true } });
	expect(checkpoint.message.content).toContain("Map &lt;existing&gt; &amp; behavior");
	expect(checkpoint.message.content).not.toContain("Keep the full scope");
	expect(checkpoint.message.content).toContain("Preserve completed steps and broad remaining outcomes");

	const latest = { customType: "plan-progress-context", content: "latest" };
	const contextResult = harness.handlers.context[0]({
		messages: [
			{ role: "user", content: "work" },
			{ customType: "plan-progress-context", content: "stale" },
			{ role: "assistant", content: [] },
			latest,
		],
	});
	expect(contextResult.messages).toEqual([
		{ role: "user", content: "work" },
		{ role: "assistant", content: [] },
		latest,
	]);
});

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
					{ step: "Restored active", description: "Resume from the saved checkpoint.", status: "in_progress" },
				],
			},
		},
	]);

	await harness.handlers.session_start[0]({}, harness.ctx);
	await harness.commands["plan-status"].handler("", harness.ctx);

	expect(harness.notifications).toEqual([{
		level: "info",
		message: "• Updated Plan\n  ├─ ✓ Restored done\n  └─ ● Restored active\n       Resume from the saved checkpoint.",
	}]);
	expect(harness.sentMessages).toHaveLength(1);
	expect(harness.sentMessages[0]!.message.content).toContain("Restored done");
	expect(harness.sentMessages[0]!.message.content).toContain("Restored active");
});
