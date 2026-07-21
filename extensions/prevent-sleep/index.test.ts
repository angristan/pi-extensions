import { expect, test } from "bun:test";
import preventSleep from "./index";

class FakeChild {
	readonly kills: string[] = [];
	private readonly listeners = new Map<string, () => void>();

	once(event: string, listener: () => void) {
		this.listeners.set(event, listener);
		return this;
	}

	kill(signal?: string) {
		this.kills.push(signal ?? "SIGTERM");
		return true;
	}

	emit(event: string) {
		this.listeners.get(event)?.();
	}
}

function createHarness(platform: NodeJS.Platform = "darwin") {
	const handlers = new Map<string, (...args: any[]) => any>();
	const children: FakeChild[] = [];
	const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
	const spawn = ((command: string, args: string[], options: unknown) => {
		calls.push({ command, args, options });
		const child = new FakeChild();
		children.push(child);
		return child;
	}) as any;

	preventSleep({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
		platform,
		pid: 4242,
		spawn,
	});

	return { handlers, children, calls };
}

test("does nothing outside macOS", () => {
	const harness = createHarness("linux");
	expect(harness.handlers.size).toBe(0);
	expect(harness.calls).toHaveLength(0);
});

test("prevents idle sleep for the complete active run", () => {
	const harness = createHarness();

	harness.handlers.get("agent_start")?.();
	harness.handlers.get("agent_start")?.(); // retry or compaction recovery

	expect(harness.calls).toEqual([{
		command: "/usr/bin/caffeinate",
		args: ["-i", "-w", "4242"],
		options: { stdio: "ignore" },
	}]);
	expect(harness.children[0].kills).toEqual([]);

	harness.handlers.get("agent_settled")?.();
	expect(harness.children[0].kills).toEqual(["SIGTERM"]);

	harness.handlers.get("agent_start")?.();
	expect(harness.calls).toHaveLength(2);
});

test("releases the assertion on session shutdown", () => {
	const harness = createHarness();

	harness.handlers.get("agent_start")?.();
	harness.handlers.get("session_shutdown")?.();
	harness.handlers.get("session_shutdown")?.();

	expect(harness.children[0].kills).toEqual(["SIGTERM"]);
});

test("recovers if caffeinate exits unexpectedly", () => {
	const harness = createHarness();

	harness.handlers.get("agent_start")?.();
	harness.children[0].emit("exit");
	harness.handlers.get("agent_start")?.();

	expect(harness.calls).toHaveLength(2);
});
