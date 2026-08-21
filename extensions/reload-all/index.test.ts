import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReloadAllExtension } from "./index";

const temporaryDirectories: string[] = [];
const originalChildMarker = process.env.PI_SUBAGENT_CHILD;

function temporaryRuntime(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-reload-all-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	if (originalChildMarker === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = originalChildMarker;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scheduler() {
	let nextId = 0;
	const timers = new Map<number, () => void>();
	return {
		timers,
		setInterval(callback: () => void) {
			const id = ++nextId;
			timers.set(id, callback);
			return id as any;
		},
		clearInterval(timer: ReturnType<typeof setInterval>) {
			timers.delete(timer as any);
		},
		async fire() {
			for (const callback of [...timers.values()]) callback();
			await Bun.sleep(10);
		},
	};
}

function makeHarness(options: {
	runtimeDirectory: string;
	key: string;
	pid: number;
	mode?: "tui" | "rpc";
	idle?: boolean;
	confirm?: boolean;
	generationId?: string;
	reloadError?: Error;
	reloadHandshake?: boolean;
	commandInvocationName?: string;
}) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const notices: string[] = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const clock = { value: 1_000 };
	const intervals = scheduler();
	let idle = options.idle ?? true;
	let reloads = 0;
	const ctx = {
		mode: options.mode ?? "tui",
		isIdle: () => idle,
		waitForIdle: async () => { idle = true; },
		reload: async () => {
			if (options.reloadError) throw options.reloadError;
			reloads += 1;
			if (options.reloadHandshake === false) return;
			const targets = join(options.runtimeDirectory, "targets");
			const path = join(targets, readdirSync(targets).find((name) => name === `${options.key}.json`)!);
			const state = JSON.parse(readFileSync(path, "utf8"));
			if (state.requestedGeneration) {
				state.appliedGeneration = state.requestedGeneration;
				state.runtimeNonce = `reloaded-${options.key}`;
				delete state.requestedGeneration;
				delete state.requestRuntimeNonce;
				writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
			}
		},
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return options.confirm ?? true;
			},
			notify: (message: string) => notices.push(message),
		},
	};
	const extension = createReloadAllExtension({
		runtimeDirectory: options.runtimeDirectory,
		pollIntervalMs: 5,
		heartbeatIntervalMs: 20,
		queueRetryAfterMs: 20,
		now: () => clock.value,
		newGenerationId: () => options.generationId ?? "generation-1",
		newRuntimeNonce: () => `runtime-${options.key}`,
		processIdentity: async () => ({ key: options.key, pid: options.pid, processStart: `start-${options.pid}` }),
		isTargetProcessAlive: async () => true,
		setInterval: intervals.setInterval,
		clearInterval: intervals.clearInterval,
	});
	extension({
		on(name: string, handler: (event: any, ctx: any) => any) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getCommands() {
			return [...commands.keys()].map((name) => ({
				name: name === "reload-all" ? options.commandInvocationName ?? name : name,
				source: "extension",
			}));
		},
		sendUserMessage(message: string) { sent.push(message); },
	} as any);

	return {
		commands,
		sent,
		notices,
		confirmations,
		intervals,
		clock,
		ctx,
		setIdle(value: boolean) { idle = value; },
		get reloads() { return reloads; },
		async emit(name: string, event: any = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		async command(args = "") {
			return commands.get("reload-all")?.handler(args, ctx);
		},
		async dispatch(message: string) {
			const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(message)!;
			return commands.get(match[1]!)?.handler(match[2] ?? "", ctx);
		},
	};
}

describe("machine-local reload broadcast", () => {
	test("reloads every registered top-level TUI exactly once", async () => {
		const runtimeDirectory = temporaryRuntime();
		const first = makeHarness({ runtimeDirectory, key: "first", pid: 101, generationId: "generation-a" });
		const second = makeHarness({ runtimeDirectory, key: "second", pid: 102 });
		await first.emit("session_start");
		await second.emit("session_start");

		await first.command();
		expect(first.confirmations[0]?.message).toContain("Reload 2 top-level TUI sessions");
		expect(first.reloads).toBe(1);

		await second.intervals.fire();
		expect(second.sent).toEqual(["/reload-all __apply runtime-second generation-a"]);
		await second.dispatch(second.sent[0]!);
		expect(second.reloads).toBe(1);

		await second.emit("session_shutdown", { reason: "reload" });
		const restored = makeHarness({ runtimeDirectory, key: "second", pid: 102 });
		await restored.emit("session_start", { reason: "reload" });
		await restored.intervals.fire();
		expect(restored.sent).toEqual([]);
		expect(restored.reloads).toBe(0);
	});

	test("dispatches early but waits inside the command for idle", async () => {
		const runtimeDirectory = temporaryRuntime();
		const sender = makeHarness({ runtimeDirectory, key: "sender", pid: 201, generationId: "generation-b" });
		const busy = makeHarness({ runtimeDirectory, key: "busy", pid: 202, idle: false });
		await sender.emit("session_start");
		await busy.emit("session_start");
		await sender.command();

		await busy.intervals.fire();
		expect(busy.sent).toEqual(["/reload-all __apply runtime-busy generation-b"]);
		await busy.dispatch(busy.sent[0]!);
		expect(busy.reloads).toBe(1);
	});

	test("does not expose or register child agents", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		const harness = makeHarness({ runtimeDirectory: temporaryRuntime(), key: "child", pid: 301 });
		await harness.emit("session_start");

		expect(harness.commands.size).toBe(0);
		expect(harness.intervals.timers.size).toBe(0);
	});

	test("does not expose or register RPC processes", async () => {
		const harness = makeHarness({ runtimeDirectory: temporaryRuntime(), key: "rpc", pid: 302, mode: "rpc" });
		await harness.emit("session_start");

		expect(harness.commands.size).toBe(0);
		expect(harness.intervals.timers.size).toBe(0);
	});

	test("does not inject the private form when the command name collides", async () => {
		const runtimeDirectory = temporaryRuntime();
		const sender = makeHarness({ runtimeDirectory, key: "sender", pid: 351, generationId: "generation-collision" });
		const collided = makeHarness({
			runtimeDirectory,
			key: "collided",
			pid: 352,
			commandInvocationName: "reload-all:1",
		});
		await sender.emit("session_start");
		await collided.emit("session_start");
		await sender.command();
		await collided.intervals.fire();

		expect(collided.sent).toEqual([]);
	});

	test("requires the private apply command to match a pending generation", async () => {
		const harness = makeHarness({ runtimeDirectory: temporaryRuntime(), key: "target", pid: 401 });
		await harness.emit("session_start");

		await harness.dispatch("/reload-all __apply runtime-target invented-generation");
		expect(harness.reloads).toBe(0);
	});

	test("retries when Pi resolves reload without starting a new runtime", async () => {
		const runtimeDirectory = temporaryRuntime();
		const sender = makeHarness({ runtimeDirectory, key: "sender", pid: 451, generationId: "generation-refused" });
		const refused = makeHarness({ runtimeDirectory, key: "refused", pid: 452, reloadHandshake: false });
		await sender.emit("session_start");
		await refused.emit("session_start");
		await sender.command();
		await refused.intervals.fire();
		await refused.dispatch(refused.sent[0]!);
		expect(refused.reloads).toBe(1);

		refused.clock.value += 25;
		await refused.intervals.fire();
		expect(refused.sent).toEqual([
			"/reload-all __apply runtime-refused generation-refused",
			"/reload-all __apply runtime-refused generation-refused",
		]);
	});

	test("rolls back acknowledgement when reload fails", async () => {
		const runtimeDirectory = temporaryRuntime();
		const sender = makeHarness({ runtimeDirectory, key: "sender", pid: 501, generationId: "generation-c" });
		const failing = makeHarness({ runtimeDirectory, key: "failing", pid: 502, reloadError: new Error("reload failed") });
		await sender.emit("session_start");
		await failing.emit("session_start");
		await sender.command();
		await failing.intervals.fire();
		await expect(failing.dispatch(failing.sent[0]!)).rejects.toThrow("reload failed");

		failing.clock.value += 25;
		await failing.intervals.fire();
		expect(failing.sent).toEqual([
			"/reload-all __apply runtime-failing generation-c",
			"/reload-all __apply runtime-failing generation-c",
		]);
	});
});
