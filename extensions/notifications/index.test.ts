import { expect, test } from "bun:test";

const { default: notificationsExtension } = await import("./index");

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
