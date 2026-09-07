import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, CYAN, GREEN, RESET } from "../better-native-pi/render";
import contextManagement, {
	BASE_BUDGET_PERCENT,
	CONTEXT_ROLLOVER_ENTRY,
	FALLBACK_BUFFER_TOKENS,
	filterContextAfterRollover,
	REMINDER_REMAINING_TOKENS,
	restoreContextManagementState,
} from "./index";

function makeHarness(initialEntries: any[] = []) {
	const entries = [...initialEntries];
	const messages: any[] = [];
	const messageOptions: any[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const entryRenderers = new Map<string, any>();
	const tools = new Map<string, any>();
	const notices: Array<[string, string]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const activeTools = new Set<string>();
	let nextId = entries.length + 1;
	let usage: any = { tokens: 10_000, contextWindow: 100_000, percent: 10 };
	let idle = false;
	let abortCalls = 0;
	let compactCalls = 0;

	const sessionManager = {
		getBranch: () => entries,
		getLeafId: () => entries.at(-1)?.id ?? null,
	};
	const ctx = {
		sessionManager,
		getContextUsage: () => usage,
		isIdle: () => idle,
		abort: () => { abortCalls += 1; },
		compact: () => { compactCalls += 1; },
		ui: {
			notify: (message: string, level: string) => notices.push([message, level]),
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
		},
	};
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerEntryRenderer(name: string, renderer: any) { entryRenderers.set(name, renderer); },
		registerTool(tool: any) { tools.set(tool.name, tool); activeTools.add(tool.name); },
		on(name: string, handler: any) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
		},
		appendEntry(customType: string, data: any) {
			entries.push({ type: "custom", id: `e${nextId++}`, customType, data });
		},
		sendMessage(message: any, options?: any) {
			const persisted = { type: "custom_message", id: `e${nextId++}`, ...message };
			entries.push(persisted);
			messages.push({ role: "custom", timestamp: nextId, ...message });
			messageOptions.push(options);
		},
	};
	contextManagement(pi as any, {
		keyHint: (_binding, description) => `Ctrl+O ${description}`,
	});

	return {
		activeTools,
		commands,
		ctx,
		entries,
		entryRenderers,
		handlers,
		messages,
		messageOptions,
		notices,
		statuses,
		tools,
		get abortCalls() { return abortCalls; },
		get compactCalls() { return compactCalls; },
		setIdle(value: boolean) { idle = value; },
		setUsage(value: any) { usage = value; },
		async emit(name: string, event: any = {}) {
			let result: any;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
	};
}

const toolNames = ["context_notes", "context_history", "get_context_remaining", "new_context"];
const renderTheme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function rendered(component: any, width = 120): string[] {
	return component.render(width).map(stripAnsi);
}

async function enable(harness: ReturnType<typeof makeHarness>) {
	await harness.emit("session_start", { reason: "startup" });
	await harness.commands.get("context-management").handler("on", harness.ctx);
}

test("persists the toggle per session and restores it from the active branch", async () => {
	const harness = makeHarness();
	await harness.emit("session_start", { reason: "startup" });
	expect([...harness.activeTools]).not.toEqual(expect.arrayContaining(toolNames));

	await harness.commands.get("context-management").handler("on", harness.ctx);
	expect([...harness.activeTools]).toEqual(expect.arrayContaining(toolNames));
	expect(harness.entries.at(-1)?.data).toEqual({ enabled: true });
	expect(harness.statuses.at(-1)).toEqual(["context-management", "ctx:auto"]);

	const restored = makeHarness(harness.entries);
	await restored.emit("session_start", { reason: "resume" });
	expect([...restored.activeTools]).toEqual(expect.arrayContaining(toolNames));
	await restored.commands.get("context-management").handler("status", restored.ctx);
	expect(restored.notices.at(-1)?.[0]).toContain("is on");

	await restored.commands.get("context-management").handler("off", restored.ctx);
	expect([...restored.activeTools]).not.toEqual(expect.arrayContaining(toolNames));
	expect(restored.entries.at(-1)?.data).toEqual({ enabled: false });
});

test("restores append-only durable notes including deletion", () => {
	const restored = restoreContextManagementState([
		{ type: "custom", customType: "context-management-state", data: { enabled: true } },
		{ type: "custom", customType: "context-management-note", data: { key: "task", content: "first" } },
		{ type: "custom", customType: "context-management-note", data: { key: "other", content: "keep" } },
		{ type: "custom", customType: "context-management-note", data: { key: "task", content: "second" } },
		{ type: "custom", customType: "context-management-note", data: { key: "task", deleted: true } },
	]);

	expect(restored.enabled).toBe(true);
	expect([...restored.notes.entries()]).toEqual([["other", "keep"]]);
});

test("writes notes and searches transcript hidden before a rollover", async () => {
	const harness = makeHarness([
		{ id: "u1", type: "message", message: { role: "user", content: "find the blue widget" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Located it in warehouse seven." }] } },
	]);
	await enable(harness);

	const notes = harness.tools.get("context_notes");
	expect((await notes.execute("n1", { action: "write", key: "task", content: "Inspect warehouse seven" })).details).toEqual({ saved: true, key: "task" });
	expect((await notes.execute("n2", { action: "read", key: "task" })).content[0].text).toBe("Inspect warehouse seven");

	const history = harness.tools.get("context_history");
	const result = await history.execute("h1", { query: "warehouse", limit: 5 }, undefined, undefined, harness.ctx);
	expect(result.details.matches).toBe(1);
	expect(result.content[0].text).toContain("Located it in warehouse seven.");
});

test("new_context drops the tool call and result while retaining the durable handoff", async () => {
	const harness = makeHarness();
	await enable(harness);
	await harness.tools.get("context_notes").execute("n1", { action: "write", key: "checkpoint", content: "Tests are passing" });
	const result = await harness.tools.get("new_context").execute("r1", { reason: "budget" }, undefined, undefined, harness.ctx);
	const marker = harness.entries.findLast((entry) => entry.customType === "context-management-rollover");
	const handoff = harness.messages.at(-1);
	const oldMessages = [
		{ role: "user", content: "old request", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", name: "new_context", id: "r1", arguments: {} }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "r1", toolName: "new_context", content: result.content, timestamp: 3 },
		handoff,
		{ role: "assistant", content: "continued work", timestamp: 4 },
	] as any[];

	const filtered = filterContextAfterRollover(oldMessages, marker.data.id) as any[];
	expect(result.content[0].text).toContain("without summarizing conversation history");
	expect(filtered).toHaveLength(2);
	expect(filtered[0].customType).toBe("context-management-handoff");
	expect(filtered[0].content).toContain("checkpoint");
	expect(filtered[1].content).toBe("continued work");

	harness.setIdle(true);
	await harness.emit("agent_settled", {});
	expect(harness.compactCalls).toBe(1);
});

test("issues one reminder then reserves the emergency buffer for a durable note", async () => {
	const harness = makeHarness();
	await enable(harness);
	const toolTurn = { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] } };
	const baseLimit = 100_000 * BASE_BUDGET_PERCENT / 100;

	harness.setUsage({
		tokens: baseLimit - REMINDER_REMAINING_TOKENS,
		contextWindow: 100_000,
		percent: (baseLimit - REMINDER_REMAINING_TOKENS) / 1_000,
	});
	await harness.emit("turn_end", toolTurn);
	await harness.emit("turn_end", toolTurn);
	expect(harness.entries.filter((entry) => entry.customType === "context-management-reminder")).toHaveLength(1);

	harness.setUsage({ tokens: baseLimit, contextWindow: 100_000, percent: BASE_BUDGET_PERCENT });
	await harness.emit("turn_end", toolTurn);
	expect(harness.entries.filter((entry) => entry.customType === "context-management-fallback")).toHaveLength(1);
	expect(harness.entries.some((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY)).toBe(false);
	expect(harness.messageOptions.at(-1)).toEqual({ triggerTurn: true, deliverAs: "steer" });

	expect(await harness.emit("tool_call", { toolName: "bash", input: {} })).toMatchObject({ block: true, terminate: true });
	expect(await harness.emit("tool_call", { toolName: "new_context", input: {} })).toMatchObject({ block: true, terminate: true });
	await harness.tools.get("context_notes").execute("checkpoint", {
		action: "write",
		key: "task",
		content: "Preserve current progress",
	});
	expect(await harness.emit("tool_call", { toolName: "new_context", input: {} })).toBeUndefined();

	const restored = restoreContextManagementState(harness.entries);
	expect(restored.fallbackPrompted).toBe(true);
	expect(restored.fallbackNoteSaved).toBe(true);
});

test("does not reset after a final response and resets before the next idle input", async () => {
	const harness = makeHarness();
	await enable(harness);
	harness.setUsage({ tokens: 90_500, contextWindow: 100_000, percent: 90.5 });

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
	expect(harness.entries.some((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY)).toBe(false);

	await harness.emit("input", { source: "interactive", text: "queued while busy" });
	expect(harness.entries.some((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY)).toBe(false);

	harness.setIdle(true);
	await harness.emit("input", { source: "interactive", text: "next task" });
	const rollover = harness.entries.find((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY);
	expect(rollover.data).toMatchObject({ reason: "automatic", percent: 90.5, tokens: 90_500, contextWindow: 100_000 });
	expect(harness.compactCalls).toBe(1);
	expect(harness.messageOptions.at(-1)).toEqual({ triggerTurn: false });

	const renderer = harness.entryRenderers.get(CONTEXT_ROLLOVER_ENTRY);
	const line = rendered(renderer(rollover, { expanded: false }, renderTheme), 72)[0];
	expect(line).toContain("Context reset — automatic at 90.5% — no summary");
	expect(line).toStartWith("─");
	expect(line).toEndWith("─");
	expect(visibleWidth(line)).toBe(70);
});

test("aborts and rolls over only when the emergency buffer is exhausted", async () => {
	const harness = makeHarness();
	await enable(harness);
	const hardLimit = Math.min(100_000, 90_000 + FALLBACK_BUFFER_TOKENS);
	const toolTurn = { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] } };
	harness.setUsage({ tokens: hardLimit, contextWindow: 100_000, percent: 100 });

	await harness.emit("turn_end", toolTurn);
	expect(harness.abortCalls).toBe(1);
	expect(harness.entries.filter((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY)).toHaveLength(1);
	expect(harness.messageOptions.at(-1)).toEqual({ triggerTurn: true, deliverAs: "steer" });
});

test("active threshold compaction is cancelled while the fallback saves state", async () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "old" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: "working", stopReason: "toolUse" } },
		{ id: "t1", type: "message", message: { role: "toolResult", content: "result" } },
	];
	const harness = makeHarness(branch);
	await enable(harness);
	harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
	const result = await harness.emit("session_before_compact", {
		reason: "threshold",
		branchEntries: branch,
		preparation: { firstKeptEntryId: "a1", tokensBefore: 90_000 },
	});

	expect(result).toEqual({ cancel: true });
	expect(harness.entries.some((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY)).toBe(false);
	expect(harness.messages.at(-1)?.customType).toBe("context-management-fallback");
});

test("idle threshold preflight creates a real no-summary compaction boundary", async () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "old" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: "done", stopReason: "stop" } },
	];
	const harness = makeHarness(branch);
	await enable(harness);
	harness.setIdle(true);
	harness.setUsage({ tokens: 90_500, contextWindow: 100_000, percent: 90.5 });
	const result = await harness.emit("session_before_compact", {
		reason: "threshold",
		branchEntries: branch,
		preparation: { firstKeptEntryId: "u1", tokensBefore: 90_500 },
	});

	const marker = harness.entries.find((entry) => entry.customType === CONTEXT_ROLLOVER_ENTRY);
	expect(result.compaction).toMatchObject({
		firstKeptEntryId: marker.id,
		tokensBefore: 90_500,
		estimatedTokensAfter: 0,
		details: { contextManagement: true, noSummary: true },
	});
	expect(result.compaction.summary).toStartWith("[context-management:no-summary]");
	expect(harness.messageOptions.at(-1)).toEqual({ triggerTurn: false });
});

test("manual and overflow compaction keep Pi's native behavior", async () => {
	const harness = makeHarness();
	await enable(harness);
	const event = { branchEntries: [], preparation: { firstKeptEntryId: "x", tokensBefore: 10 } };
	expect(await harness.emit("session_before_compact", { ...event, reason: "manual" })).toBeUndefined();
	expect(await harness.emit("session_before_compact", { ...event, reason: "overflow" })).toBeUndefined();
});

test("renders every context tool as compact native-style blocks", async () => {
	const harness = makeHarness([
		{ id: "u1", type: "message", message: { role: "user", content: "inspect warehouse seven" } },
	]);
	await enable(harness);
	const notes = harness.tools.get("context_notes");
	const history = harness.tools.get("context_history");
	const remaining = harness.tools.get("get_context_remaining");
	const rollover = harness.tools.get("new_context");
	for (const tool of [notes, history, remaining, rollover]) expect(tool.renderShell).toBe("self");

	const noteArgs = { action: "write", key: "task", content: "Inspect warehouse seven\nThen verify output" };
	expect(rendered(notes.renderCall(noteArgs, renderTheme, { isPartial: true }))).toEqual([
		"• Saving context checkpoint task",
		"  └ Inspect warehouse seven Then verify output",
	]);
	const noteResult = await notes.execute("note", noteArgs);
	const listedNotes = await notes.execute("list", { action: "list" });
	expect(rendered(notes.renderResult(listedNotes, { isPartial: false, expanded: false }, renderTheme, { args: { action: "list" }, isError: false }))).toEqual([
		"• Listed 1 saved context checkpoint",
		"  └ task",
	]);
	const styledNote = notes.renderResult(noteResult, { isPartial: false, expanded: false }, renderTheme, { args: noteArgs, isError: false });
	expect(rendered(styledNote)).toEqual([
		"• Saved context checkpoint task",
		"  └ Inspect warehouse seven Then verify output · Ctrl+O to expand",
	]);
	const styledNoteText = styledNote.render(120).join("\n");
	expect(styledNoteText).toContain(`${CYAN}task${RESET}`);
	expect(styledNoteText).not.toContain(BOLD);
	const expandedNote = rendered(notes.renderResult(noteResult, { isPartial: false, expanded: true }, renderTheme, { args: noteArgs, isError: false }), 36);
	expect(expandedNote.every((line: string) => visibleWidth(line) <= 36)).toBe(true);
	expect(expandedNote).toEqual([
		"• Saved context checkpoint task",
		"  └ Inspect warehouse seven",
		"    Then verify output",
	]);
	expect(expandedNote.join("\n")).not.toContain("Ctrl+O");

	const longNoteArgs = {
		action: "write",
		key: "session-context-management",
		content: "Context management is enabled for this Pi session and remains active after reload.",
	};
	const longNoteResult = await notes.execute("long-note", longNoteArgs);
	const narrowNote = rendered(notes.renderResult(
		longNoteResult,
		{ isPartial: false, expanded: false },
		renderTheme,
		{ args: longNoteArgs, isError: false },
	), 48);
	expect(narrowNote[0]).toContain("Saved context checkpoint");
	expect(narrowNote).toHaveLength(2);
	expect(narrowNote[1]?.trimStart()).toStartWith("└ Context management");
	expect(narrowNote[1]?.trimStart()).not.toStartWith("·");
	expect(narrowNote[1]).toContain("Ctrl+O to expand");

	const historyArgs = { query: "warehouse", limit: 5 };
	expect(rendered(history.renderCall(historyArgs, renderTheme, { isPartial: true }))).toEqual([
		"• Searching full session transcript",
		"  └ warehouse · last 5",
	]);
	const historyResult = await history.execute("history", historyArgs, undefined, undefined, harness.ctx);
	const styledHistory = history.renderResult(historyResult, { isPartial: false, expanded: false }, renderTheme, { args: historyArgs, isError: false });
	expect(rendered(styledHistory)).toEqual([
		"• Found 1 message matching warehouse in full transcript",
		"  └ [u1 user] inspect warehouse seven",
	]);
	expect(styledHistory.render(120).join("\n")).toContain(`${GREEN}1${RESET}`);
	const expandedHistory = history.renderResult(historyResult, { isPartial: false, expanded: true }, renderTheme, { args: historyArgs, isError: false }).render(32);
	expect(expandedHistory.every((line: string) => visibleWidth(line) <= 32)).toBe(true);
	expect(stripAnsi(expandedHistory.join(" ")).replace(/\s+/g, " ")).toContain("inspect warehouse seven");

	const multiHistory = {
		content: [{ type: "text", text: "[u1 user] first match\n\n[a2 assistant] second match" }],
		details: { matches: 2 },
	};
	const collapsedMultiHistory = rendered(history.renderResult(
		multiHistory,
		{ isPartial: false, expanded: false },
		renderTheme,
		{ args: historyArgs, isError: false },
	));
	expect(collapsedMultiHistory.at(-1)).toContain("Ctrl+O to expand");
	const expandedMultiHistory = rendered(history.renderResult(
		multiHistory,
		{ isPartial: false, expanded: true },
		renderTheme,
		{ args: historyArgs, isError: false },
	));
	expect(expandedMultiHistory.join("\n")).toContain("second match");
	expect(expandedMultiHistory.join("\n")).not.toContain("Ctrl+O");

	const emptyHistory = await history.execute("empty", { query: "missing", limit: 5 }, undefined, undefined, harness.ctx);
	expect(rendered(history.renderResult(emptyHistory, { isPartial: false, expanded: false }, renderTheme, { args: { query: "missing", limit: 5 }, isError: false }))).toEqual([
		"• No messages matching missing in full transcript",
	]);

	expect(rendered(remaining.renderCall({}, renderTheme, { isPartial: true }))).toEqual([
		"• Checking context window",
	]);
	const remainingResult = await remaining.execute("remaining", {}, undefined, undefined, harness.ctx);
	const styledRemaining = remaining.renderResult(remainingResult, { isPartial: false, expanded: false }, renderTheme, { args: {}, isError: false });
	expect(rendered(styledRemaining)).toEqual([
		"• Checked context window",
		"  └ 10.0% used · 80K tokens remain",
	]);
	expect(styledRemaining.render(120).join("\n")).toContain(`${GREEN}10.0%${RESET}`);

	const rolloverArgs = { reason: "refresh model context" };
	expect(rendered(rollover.renderCall(rolloverArgs, renderTheme, { isPartial: true }))).toEqual([
		"• Resetting model context",
		"  └ refresh model context",
	]);
	const rolloverResult = await rollover.execute("rollover", rolloverArgs, undefined, undefined, harness.ctx);
	expect(rendered(rollover.renderResult(rolloverResult, { isPartial: false, expanded: false }, renderTheme, { args: rolloverArgs, isError: false }))).toEqual([
		"• Reset model context",
		"  └ refresh model context · without conversation summary",
	]);
});

test("renders disabled and failed context operations distinctly", async () => {
	const harness = makeHarness();
	await harness.emit("session_start", { reason: "startup" });
	const notes = harness.tools.get("context_notes");
	const disabled = await notes.execute("disabled", { action: "list" });
	expect(rendered(notes.renderResult(disabled, { isPartial: false, expanded: false }, renderTheme, { args: { action: "list" }, isError: false }))).toEqual([
		"• Context checkpoint failed",
		"  └ Context management is disabled for this session. Enable it with /context-management on.",
	]);

	const history = harness.tools.get("context_history");
	expect(rendered(history.renderResult(
		{ content: [{ type: "text", text: "Provider failed\u001b[31m badly\u001b[0m" }] },
		{ isPartial: false, expanded: false },
		renderTheme,
		{ args: { query: "failure" }, isError: true },
	))).toEqual([
		"• Transcript search failed",
		"  └ Provider failed badly",
	]);
});
