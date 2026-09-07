import { expect, test } from "bun:test";
import autoCompactContinue from "./index";

function makeHarness(entries: any[]) {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const sent: any[] = [];
	const ctx = {
		isIdle: () => false,
		sessionManager: { getBranch: () => entries },
	};
	autoCompactContinue({
		on(name: string, callback: any) { handlers.set(name, callback); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	} as any);
	return { ctx, handlers, sent };
}

test("continues an interrupted tool turn only after the run settles", () => {
	const entries = [
		{ id: "a1", type: "message", message: { role: "assistant", stopReason: "toolUse" } },
		{ id: "t1", type: "message", message: { role: "toolResult" } },
		{ id: "c1", type: "compaction" },
	];
	const { ctx, handlers, sent } = makeHarness(entries);

	handlers.get("session_compact")!({ reason: "threshold", willRetry: false, compactionEntry: entries[2] }, ctx);
	expect(sent).toHaveLength(0);

	handlers.get("agent_settled")!({}, ctx);
	expect(sent).toHaveLength(1);
	expect(sent[0].message).toMatchObject({ customType: "auto-compact-continue", display: false, details: { reason: "threshold", noSummary: false } });
	expect(sent[0].message.content).toContain("completed or retired session goal may be historical");
	expect(sent[0].message.content).toContain("summary shows no current work remains");
	expect(sent[0].options).toEqual({ triggerTurn: true });
});

test("does not queue a stale continuation when the tool turn resumes naturally", () => {
	const entries = [
		{ id: "a1", type: "message", message: { role: "assistant", stopReason: "toolUse" } },
		{ id: "t1", type: "message", message: { role: "toolResult" } },
		{ id: "c1", type: "compaction" },
	];
	const { ctx, handlers, sent } = makeHarness(entries);

	handlers.get("session_compact")!({ reason: "threshold", willRetry: false, compactionEntry: entries[2] }, ctx);
	entries.push({ id: "a2", type: "message", message: { role: "assistant", stopReason: "stop" } });
	handlers.get("agent_settled")!({}, ctx);

	expect(sent).toHaveLength(0);
});

test("does not continue compaction after a completed assistant response", () => {
	const entries = [
		{ id: "a1", type: "message", message: { role: "assistant", stopReason: "stop" } },
		{ id: "c1", type: "compaction" },
	];
	const { ctx, handlers, sent } = makeHarness(entries);

	handlers.get("session_compact")!({ reason: "threshold", willRetry: false, compactionEntry: entries[1] }, ctx);
	handlers.get("agent_settled")!({}, ctx);

	expect(sent).toHaveLength(0);
});

test("uses rollover guidance after a no-summary context reset", () => {
	const entries = [
		{ id: "a1", type: "message", message: { role: "assistant", stopReason: "toolUse" } },
		{ id: "c1", type: "compaction", details: { contextManagement: true, noSummary: true } },
	];
	const { ctx, handlers, sent } = makeHarness(entries);

	handlers.get("session_compact")!({ reason: "threshold", willRetry: false, compactionEntry: entries[1] }, ctx);
	handlers.get("agent_settled")!({}, ctx);

	expect(sent[0].message.content).toContain("without a conversation summary");
	expect(sent[0].message.content).toContain("durable context notes");
	expect(sent[0].message.details.noSummary).toBe(true);
});

test("leaves manual, retrying, and idle compactions alone", () => {
	const entries = [
		{ id: "a1", type: "message", message: { role: "assistant", stopReason: "toolUse" } },
		{ id: "c1", type: "compaction" },
	];
	const { ctx, handlers, sent } = makeHarness(entries);

	handlers.get("session_compact")!({ reason: "manual", willRetry: false, compactionEntry: entries[1] }, ctx);
	handlers.get("session_compact")!({ reason: "threshold", willRetry: true, compactionEntry: entries[1] }, ctx);
	handlers.get("session_compact")!({ reason: "threshold", willRetry: false, compactionEntry: entries[1] }, { ...ctx, isIdle: () => true });
	handlers.get("agent_settled")!({}, ctx);
	expect(sent).toHaveLength(0);
});
