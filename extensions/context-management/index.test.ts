import { expect, test } from "bun:test";
import contextManagement, {
	filterContextAfterRollover,
	REMINDER_PERCENT,
	ROLLOVER_PERCENT,
	restoreContextManagementState,
} from "./index";

function makeHarness(initialEntries: any[] = []) {
	const entries = [...initialEntries];
	const messages: any[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const notices: Array<[string, string]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const activeTools = new Set<string>();
	let nextId = entries.length + 1;
	let usage: any = { tokens: 10, contextWindow: 100, percent: 10 };

	const sessionManager = {
		getBranch: () => entries,
		getLeafId: () => entries.at(-1)?.id ?? null,
	};
	const ctx = {
		sessionManager,
		getContextUsage: () => usage,
		ui: {
			notify: (message: string, level: string) => notices.push([message, level]),
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
		},
	};
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
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
		sendMessage(message: any) {
			const persisted = { type: "custom_message", id: `e${nextId++}`, ...message };
			entries.push(persisted);
			messages.push({ role: "custom", timestamp: nextId, ...message });
		},
	};
	contextManagement(pi as any);

	return {
		activeTools,
		commands,
		ctx,
		entries,
		handlers,
		messages,
		notices,
		statuses,
		tools,
		setUsage(value: any) { usage = value; },
		async emit(name: string, event: any = {}) {
			let result: any;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
	};
}

const toolNames = ["context_notes", "context_history", "get_context_remaining", "new_context"];

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
	const result = await harness.tools.get("new_context").execute("r1", { reason: "budget" });
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
});

test("usage thresholds issue one reminder and then create a rollover", async () => {
	const harness = makeHarness();
	await enable(harness);

	harness.setUsage({ tokens: REMINDER_PERCENT, contextWindow: 100, percent: REMINDER_PERCENT });
	await harness.emit("turn_end", {});
	await harness.emit("turn_end", {});
	expect(harness.entries.filter((entry) => entry.customType === "context-management-reminder")).toHaveLength(1);

	harness.setUsage({ tokens: ROLLOVER_PERCENT, contextWindow: 100, percent: ROLLOVER_PERCENT });
	await harness.emit("turn_end", {});
	expect(harness.entries.filter((entry) => entry.customType === "context-management-rollover")).toHaveLength(1);
	expect(harness.entries.at(-1)?.customType).toBe("context-management-handoff");
});

test("threshold compaction skips summarization and preserves a pending user prompt", async () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "old" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: "done" } },
		{ id: "u2", type: "message", message: { role: "user", content: "current request" } },
	];
	const harness = makeHarness(branch);
	await enable(harness);
	const result = await harness.emit("session_before_compact", {
		reason: "threshold",
		branchEntries: branch,
		preparation: { firstKeptEntryId: "a1", tokensBefore: 91 },
	});

	expect(result.compaction.firstKeptEntryId).toBe("u2");
	expect(result.compaction.tokensBefore).toBe(91);
	expect(result.compaction.details.noSummary).toBe(true);

	const transformed = filterContextAfterRollover([
		{ role: "compactionSummary", summary: result.compaction.summary, tokensBefore: 91, timestamp: 1 },
		{ role: "user", content: "current request", timestamp: 2 },
	] as any, harness.entries.at(-1)?.data.id) as any[];
	expect(transformed.map((message) => message.role)).toEqual(["custom", "user"]);
	expect(transformed[0].content).toContain("without a summary");
});

test("manual and overflow compaction keep Pi's native behavior", async () => {
	const harness = makeHarness();
	await enable(harness);
	const event = { branchEntries: [], preparation: { firstKeptEntryId: "x", tokensBefore: 10 } };
	expect(await harness.emit("session_before_compact", { ...event, reason: "manual" })).toBeUndefined();
	expect(await harness.emit("session_before_compact", { ...event, reason: "overflow" })).toBeUndefined();
});
