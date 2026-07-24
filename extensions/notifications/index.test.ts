import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: notificationsExtension, notificationsConfigPath } = await import("./index");

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-notifications-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	rmSync(agentDirectory, { recursive: true, force: true });
});

type Handler = (event: any, ctx: any) => any;
type BusHandler = (event: any) => any;

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function makeHarness(cwd: string) {
	const handlers: Record<string, Handler[]> = {};
	const busHandlers: Record<string, BusHandler[]> = {};
	const emitted: Array<{ name: string; payload: any }> = [];
	const ctx = {
		cwd,
		mode: "json",
		ui: {
			notify() {},
			onTerminalInput() { return () => {}; },
		},
	};

	notificationsExtension({
		events: {
			on(name: string, handler: BusHandler) {
				(busHandlers[name] ??= []).push(handler);
				return () => {};
			},
			emit(name: string, payload: any) {
				emitted.push({ name, payload });
				for (const handler of busHandlers[name] ?? []) handler(payload);
			},
		},
		on(name: string, handler: Handler) { (handlers[name] ??= []).push(handler); },
		registerCommand() {},
	} as any);

	return {
		emitted,
		emitBus(name: string, payload: any) {
			for (const handler of busHandlers[name] ?? []) handler(payload);
		},
		async emit(name: string, payload: any = {}) {
			for (const handler of handlers[name] ?? []) await handler(payload, ctx);
		},
	};
}

async function captureBellWrites(run: (writes: string[]) => Promise<void> | void) {
	const writes: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: any) => {
		writes.push(String(chunk));
		return true;
	}) as any;
	try {
		await run(writes);
	} finally {
		process.stdout.write = originalWrite;
	}
}

function bellCount(writes: string[]): number {
	return writes.filter((write) => write.includes("\x07")).length;
}

test("reads config from the configured Pi agent directory", () => {
	expect(notificationsConfigPath()).toBe(join(agentDirectory, "notifications.json"));
});

test("rings on a normal completed turn", async () => {
	await captureBellWrites(async (writes) => {
		const h = makeHarness("/tmp/pi-notifications-normal");
		await h.emit("session_start");
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("normal turn done")] });
		await h.emit("agent_settled");

		expect(bellCount(writes)).toBe(1);
	});
});

test("uses turn completion after a failed tool succeeds on retry", async () => {
	await captureBellWrites(async (writes) => {
		const h = makeHarness("/tmp/pi-notifications-recovered");
		await h.emit("session_start");
		await h.emit("agent_start");
		await h.emit("tool_execution_end", {
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: "first attempt failed" }] },
		});
		await h.emit("tool_execution_end", {
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "retry succeeded" }] },
		});
		await h.emit("agent_end", { messages: [assistant("recovered successfully")] });
		await h.emit("agent_settled");

		expect(bellCount(writes)).toBe(1);
		const state = (globalThis as any)[Symbol.for("pi.notifications.state")];
		expect(state.lastSignature).toBe("pi-notifications-recovered: turn complete\0recovered successfully");
	});
});

test("suppresses routine turn-complete bells while a goal is active", async () => {
	await captureBellWrites(async (writes) => {
		const h = makeHarness("/tmp/pi-notifications-active-goal");
		await h.emit("session_start");
		h.emitBus("goal:changed", { status: "active", objective: "keep working" });
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("intermediate goal turn")] });
		await h.emit("agent_settled");

		expect(bellCount(writes)).toBe(0);
	});
});

test("rings once when an active goal completes and skips generic completion", async () => {
	await captureBellWrites(async (writes) => {
		const h = makeHarness("/tmp/pi-notifications-complete-goal");
		await h.emit("session_start");
		h.emitBus("goal:changed", { status: "active", objective: "ship compact overlay" });
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("goal complete summary")] });
		h.emitBus("goal:changed", { status: "complete", objective: "ship compact overlay" });
		await h.emit("agent_settled");

		expect(bellCount(writes)).toBe(1);
	});
});

test("still rings for questions while a goal is active", async () => {
	await captureBellWrites(async (writes) => {
		const h = makeHarness("/tmp/pi-notifications-question-goal");
		await h.emit("session_start");
		h.emitBus("goal:changed", { status: "active", objective: "wait for input" });
		await h.emit("agent_start");
		await h.emit("tool_execution_start", { toolName: "questionnaire" });
		await h.emit("agent_end", { messages: [assistant("waiting")] });
		await h.emit("agent_settled");

		expect(bellCount(writes)).toBe(1);
	});
});
