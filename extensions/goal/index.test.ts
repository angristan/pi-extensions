import { expect, mock, test } from "bun:test";

class Text {
	constructor(private readonly text: string) {}
	render(): string[] { return this.text.split("\n"); }
	invalidate(): void {}
}

mock.module("@earendil-works/pi-tui", () => ({
	Text,
	Container: class Container { render(): string[] { return []; } invalidate(): void {} },
	truncateToWidth: (text: string, width: number, suffix = "") => {
		if (text.length <= width) return text;
		return `${text.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
	},
	visibleWidth: (text: string) => text.length,
	wrapTextWithAnsi: (text: string, width: number) => {
		const lines: string[] = [];
		for (const paragraph of text.split("\n")) {
			let current = "";
			for (const word of paragraph.split(/\s+/).filter(Boolean)) {
				if (!current) current = word;
				else if (current.length + 1 + word.length <= width) current += ` ${word}`;
				else { lines.push(current); current = word; }
			}
			lines.push(current);
		}
		return lines;
	},
}));

// The goal tools now render as compact 2-line blocks reusing better-native-pi's
// palette + line-fitting helpers; stub them so the render slots are testable
// without pulling the real restyler module graph.
mock.module("../better-native-pi/core.js", () => ({
	fitToolLine: (line: string) => line,
	formatElapsed: (elapsedMs: number) => (elapsedMs < 1_000 ? "<1s" : `${Math.round(elapsedMs / 100) / 10}s`),
}));
mock.module("../better-native-pi/render.js", () => ({
	BOLD: "<bold>",
	GREEN: "<green>",
	MAGENTA: "<magenta>",
	RED: "<red>",
	RESET: "</>",
}));

mock.module("../overlay-stack/index.js", () => ({
	registerOverlayCard: () => ({ invalidate() {}, unregister() {} }),
}));

mock.module("typebox", () => ({
	Type: {
		Object: (schema: any) => ({ type: "object", ...schema }),
		Optional: (schema: any) => ({ ...schema, optional: true }),
		String: (options?: any) => ({ type: "string", ...options }),
	},
}));

const { buildGoalContext, renderGoalOverlayBody, default: goalExtension } = await import("./index");

function makeHarness() {
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, any> = {};
	const tools: Record<string, any> = {};
	const activeTools = new Set<string>();
	const entries: any[] = [];
	const sent: Array<{ message: any; options: any }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const confirmCalls: Array<{ title: string; message: string }> = [];
	const confirmResponses: boolean[] = [];
	let editorValue: string | undefined;

	const ctx: any = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: {
			getBranch: () => entries,
			getEntries: () => entries,
		},
		ui: {
			notify(message: string, type?: string) { notifications.push({ message, type }); },
			setStatus() {},
			confirm(title: string, message: string) {
				confirmCalls.push({ title, message });
				return Promise.resolve(confirmResponses.length ? confirmResponses.shift()! : true);
			},
			editor(_title: string, _source: string) { return Promise.resolve(editorValue); },
			theme: { bold: (text: string) => text, fg: (_color: string, text: string) => text },
		},
	};

	goalExtension({
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
		events: { emit() {}, on() { return () => {}; } },
		on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
		registerCommand(name: string, command: any) { commands[name] = command; },
		registerTool(tool: any) { tools[tool.name] = tool; activeTools.add(tool.name); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
		},
	} as any);

	return {
		handlers,
		commands,
		tools,
		activeTools,
		entries,
		sent,
		notifications,
		confirmCalls,
		confirmResponses,
		ctx,
		setEditorValue(value: string | undefined) { editorValue = value; },
	};
}

async function emit(harness: ReturnType<typeof makeHarness>, event: string, payload: any = {}) {
	const results: any[] = [];
	for (const handler of harness.handlers[event] ?? []) {
		results.push(await handler(payload, harness.ctx));
	}
	return results;
}

async function context(harness: ReturnType<typeof makeHarness>, messages: any[]) {
	const results = await emit(harness, "context", { messages });
	return results.find((result) => result !== undefined);
}

function latestGoalState(harness: ReturnType<typeof makeHarness>) {
	return [...harness.entries].reverse().find((entry) => entry.customType === "goal-state")?.data?.state;
}

function isContinuation(message: any) {
	return message?.customType === "goal-continuation";
}

test("renders the goal overlay as a compact summary", () => {
	const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
	const lines = renderGoalOverlayBody({
		objective: "Continue the vendor-neutral browser capture backend for the capture service while preserving parity with HTTP-only captures across discovery, filtering, assets, retries, lifecycle metadata, observability, and replayable WARC/MCDX output.",
		validation: ["parity harness passes", "WARC counts match"],
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		accumulatedActiveMs: 0,
		continuations: 3,
		elapsedMs: 125_000,
	}, 52, 40, theme, { inputTokens: 42_000, outputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 0 });

	expect(lines.length).toBeLessThanOrEqual(7);
	expect(lines[2]).toContain("/goal-status for full");
	expect(lines[3]).toBe("");
	expect(lines.slice(4).join("\n")).toContain("2m 5s active time · 3 continuations");
	expect(lines.slice(4).join("\n")).toContain("goal tokens spent 45K · ↓42K ↑3K");
});

test("wraps goal data as escaped untrusted context", () => {
	const text = buildGoalContext({
		objective: "<do>&override</do>",
		validation: ["<check>&done"],
		status: "active",
		createdAt: 0,
		updatedAt: 0,
		accumulatedActiveMs: 0,
		continuations: 0,
	});

	expect(text).toContain("<untrusted_objective>");
	expect(text).toContain("&lt;do&gt;&amp;override&lt;/do&gt;");
	expect(text).toContain("&lt;check&gt;&amp;done");
	expect(text).not.toContain("<do>&override</do>");
});

test("continuation prompt is injected transiently and stale markers are pruned", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("ship <unsafe>&", h.ctx);

	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.message.content).toBe("Goal continuation requested.");
	expect(h.sent[0]!.message.content).not.toContain("unsafe");

	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	const result = await context(h, [
		{ customType: "goal-continuation", content: "stale", display: false },
		{ role: "assistant", content: [] },
		h.sent[0]!.message,
	]);

	expect(result.messages).toHaveLength(2);
	const injected = result.messages.find(isContinuation);
	expect(injected.content).toContain("<untrusted_objective>");
	expect(injected.content).toContain("ship &lt;unsafe&gt;&amp;");
	expect(injected.content).toContain("Completion audit:");
	expect(injected.details.transient).toBe(true);

	const second = await context(h, [h.sent[0]!.message, { role: "assistant", content: [] }]);
	expect(second.messages.some(isContinuation)).toBe(false);
});

test("replacing an unfinished goal requires confirmation", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);
	const entriesAfterInitial = h.entries.length;

	h.confirmResponses.push(false);
	await h.commands.goal.handler("replacement goal", h.ctx);
	expect(h.confirmCalls).toHaveLength(1);
	expect(latestGoalState(h).objective).toBe("initial goal");
	expect(h.entries).toHaveLength(entriesAfterInitial);

	h.confirmResponses.push(true);
	await h.commands.goal.handler("replacement goal", h.ctx);
	expect(h.confirmCalls).toHaveLength(2);
	expect(latestGoalState(h).objective).toBe("replacement goal");
});

test("goal tools are active only while a goal is active", async () => {
	const h = makeHarness();
	await emit(h, "session_start");
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(false);
	}

	const stale = await h.tools.goal_complete.execute("stale", {}, undefined, undefined, h.ctx);
	expect(stale.content[0].text).toBe("");
	expect(stale.details).toMatchObject({ ok: false, ignored: true, reason: "no-goal" });

	await h.commands.goal.handler("active goal", h.ctx);
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(true);
	}

	await h.tools.goal_complete.execute("complete", {}, undefined, undefined, h.ctx);
	for (const name of ["goal_complete", "goal_block"]) {
		expect(h.activeTools.has(name)).toBe(false);
	}
});

test("editing a completed goal reactivates it and starts the loop", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);
	await h.commands.goal.handler("complete", h.ctx);
	expect(latestGoalState(h).status).toBe("complete");
	const sentBeforeEdit = h.sent.length;

	h.setEditorValue("# Goal\nreactivated goal\n\n## Validation\n- evidence checked\n");
	await h.commands.goal.handler("edit", h.ctx);

	const state = latestGoalState(h);
	expect(state.status).toBe("active");
	expect(state.completedAt).toBeUndefined();
	expect(state.objective).toBe("reactivated goal");
	expect(state.validation).toEqual(["evidence checked"]);
	expect(h.sent).toHaveLength(sentBeforeEdit + 1);
	expect(h.sent.at(-1)!.message.content).toBe("Goal continuation requested.");
});

test("terminal provider errors block the active goal instead of continuing", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("initial goal", h.ctx);
	const sentBeforeError = h.sent.length;

	await emit(h, "message_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "429 too many requests" },
	});
	await emit(h, "agent_settled", {});

	const state = latestGoalState(h);
	expect(state.status).toBe("blocked");
	expect(state.blockedAudit.fingerprint).toBe("provider-usage-limit");
	expect(state.blockedAudit.evidence).toBe("429 too many requests");
	expect(h.sent).toHaveLength(sentBeforeError);
});

// Render the lines a tool block component produces. The harness mocks the
// better-native-pi palette as plain tags, so we assert on structure, not color.
function renderBlock(component: any, width = 80): string[] {
	return component.render(width);
}

test("goal_complete renders a compact completed block and hides stale calls", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	const result = await h.tools.goal_complete.execute("call", { summary: "shipped the fix" }, undefined, undefined, h.ctx);
	const block = h.tools.goal_complete.renderResult(result, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	const lines = renderBlock(block);
	expect(lines[0]).toContain("Completed goal");
	expect(lines[1]).toContain("└");
	// The branch shows the summary (preferred) or the objective.
	expect(lines[1]).toContain("shipped the fix");

	// A stale call against no active goal renders nothing.
	const stale = { ...result, details: { ok: false, ignored: true, reason: "no-goal" } };
	const staleBlock = h.tools.goal_complete.renderResult(stale, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	expect(renderBlock(staleBlock)).toEqual([]);
});

test("goal_block renders recorded, blocked, and duplicate outcomes", async () => {
	const h = makeHarness();
	await h.commands.goal.handler("reduce p95 latency below 120ms", h.ctx);

	// First report: recorded (1/3), goal stays active.
	await emit(h, "turn_start", { turnIndex: 0, timestamp: 0 });
	const recorded = await h.tools.goal_block.execute("call-1", { blocker: "flaky CI on macOS" }, undefined, undefined, h.ctx);
	expect(recorded.details.blocked).toBe(false);
	let block = h.tools.goal_block.renderResult(recorded, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	let lines = renderBlock(block);
	expect(lines[0]).toContain("Blocker recorded");
	expect(lines[1]).toContain("flaky CI on macOS");
	expect(lines[1]).toContain("1/3");

	// Same blocker repeated to threshold across separate turns: blocked (red headline).
	let blocked: any;
	for (let i = 2; i <= 3; i++) {
		await emit(h, "turn_start", { turnIndex: i, timestamp: 0 });
		blocked = await h.tools.goal_block.execute(`call-${i}`, { blocker: "flaky CI on macOS" }, undefined, undefined, h.ctx);
	}
	expect(blocked.details.blocked).toBe(true);
	block = h.tools.goal_block.renderResult(blocked, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	lines = renderBlock(block);
	expect(lines[0]).toContain("Goal blocked");
	expect(lines[1]).toContain("flaky CI on macOS");

	// A second report in the same turn is a duplicate and renders as such.
	await h.commands.goal.handler("fresh goal", h.ctx);
	await emit(h, "turn_start", { turnIndex: 10, timestamp: 0 });
	await h.tools.goal_block.execute("dup-1", { blocker: "same blocker" }, undefined, undefined, h.ctx);
	const duplicate = await h.tools.goal_block.execute("dup-2", { blocker: "same blocker" }, undefined, undefined, h.ctx);
	expect(duplicate.details.duplicateTurn).toBe(true);
	block = h.tools.goal_block.renderResult(duplicate, { isPartial: false }, h.ctx.ui.theme, { lastComponent: undefined });
	lines = renderBlock(block);
	expect(lines[0]).toContain("Blocker already recorded");
});
