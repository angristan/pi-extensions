import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerBackgroundJobs, { BoundedOutput } from "./index";

interface Harness {
	tools: Map<string, any>;
	handlers: Map<string, (...args: any[]) => any>;
	ctx: any;
}

const cleanupGroups = new Set<number>();

afterEach(() => {
	for (const pid of cleanupGroups) {
		try { process.kill(-pid, "SIGKILL"); } catch { /* Already stopped. */ }
	}
	cleanupGroups.clear();
});

function createHarness(options: { killGraceMs?: number } = {}): Harness {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		ui: {
			confirm: async () => true,
			notify() {},
		},
		sessionManager: { getEntries: () => [] },
	};
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand() {},
		registerEntryRenderer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		appendEntry() {},
		events: { emit() {} },
	};
	registerBackgroundJobs(pi as any, options);
	return { tools, handlers, ctx };
}

async function startHarness(harness: Harness): Promise<void> {
	await harness.handlers.get("session_start")?.({}, harness.ctx);
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
			if (Number.isInteger(pid)) return pid;
		} catch { /* Process has not written the file yet. */ }
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for pid file: ${path}`);
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("BoundedOutput", () => {
	test("returns complete output when it fits the requested limit", () => {
		const output = new BoundedOutput();
		output.append(Buffer.alloc(16 * 1024, "h"));
		output.append(Buffer.alloc(4 * 1024, "t"));

		const text = output.text(24 * 1024);
		expect(Buffer.byteLength(text)).toBe(20 * 1024);
		expect(text.startsWith("h")).toBe(true);
		expect(text.endsWith("t".repeat(4 * 1024))).toBe(true);
		expect(text).not.toContain("omitted");
	});

	test("keeps the newest bytes when complete output exceeds the limit", () => {
		const output = new BoundedOutput();
		output.append(Buffer.alloc(16 * 1024, "h"));
		output.append(Buffer.alloc(9 * 1024, "t"));

		const text = output.text(24 * 1024);
		expect(text.startsWith("[... 1,024 earlier bytes omitted ...]\n")).toBe(true);
		expect(text.endsWith("t".repeat(9 * 1024))).toBe(true);
	});
});

describe("background job lifecycle", () => {
	test("requires integer timeout seconds in schema and execution", async () => {
		const harness = createHarness();
		await startHarness(harness);
		const tool = harness.tools.get("background_bash");
		expect(tool.parameters.properties.timeoutSeconds).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 86_400,
		});

		await expect(tool.execute("start", {
			command: "true",
			reasoning: "validate timeout",
			timeoutSeconds: 0.5,
		}, undefined, undefined, harness.ctx)).rejects.toThrow("must be an integer between 1 and 86400");
	});

	test("waits for SIGKILL escalation during shutdown", async () => {
		if (process.platform === "win32") return;
		const directory = await mkdtemp(join(tmpdir(), "pi-background-jobs-"));
		const pidFile = join(directory, "pid");
		const harness = createHarness({ killGraceMs: 30 });
		await startHarness(harness);

		try {
			await harness.tools.get("background_bash").execute("start", {
				command: `trap '' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done`,
				reasoning: "test shutdown cleanup",
			}, undefined, undefined, harness.ctx);
			const pid = await waitForPid(pidFile);
			cleanupGroups.add(pid);

			await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
			await Bun.sleep(10);
			expect(processGroupExists(pid)).toBe(false);
			cleanupGroups.delete(pid);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 2_000);

	test("preserves timeout status when a user also requests a stop", async () => {
		if (process.platform === "win32") return;
		const harness = createHarness({ killGraceMs: 500 });
		await startHarness(harness);
		const started = await harness.tools.get("background_bash").execute("start", {
			command: "trap '' TERM; while :; do sleep 1; done",
			reasoning: "test timeout stop race",
			timeoutSeconds: 1,
		}, undefined, undefined, harness.ctx);

		try {
			await Bun.sleep(1_100);
			const stop = await harness.tools.get("job_kill").execute("kill", {
				job_id: started.details.id,
			}, undefined, undefined, harness.ctx);
			expect(stop.content[0].text).toContain("Stop already requested");

			const finished = await harness.tools.get("job_output").execute("output", {
				job_id: started.details.id,
				wait: true,
			});
			expect(finished.details.status).toBe("timed_out");
		} finally {
			await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
		}
	}, 3_000);

	test("makes repeated stop requests idempotent", async () => {
		if (process.platform === "win32") return;
		const harness = createHarness({ killGraceMs: 50 });
		await startHarness(harness);
		const started = await harness.tools.get("background_bash").execute("start", {
			command: "trap '' TERM; while :; do sleep 1; done",
			reasoning: "test duplicate stop requests",
		}, undefined, undefined, harness.ctx);

		try {
			await Bun.sleep(50);
			const first = await harness.tools.get("job_kill").execute("kill-1", {
				job_id: started.details.id,
			}, undefined, undefined, harness.ctx);
			const second = await harness.tools.get("job_kill").execute("kill-2", {
				job_id: started.details.id,
			}, undefined, undefined, harness.ctx);
			expect(first.content[0].text).toContain("Sent SIGTERM");
			expect(second.content[0].text).toContain("Stop already requested");

			const finished = await harness.tools.get("job_output").execute("output", {
				job_id: started.details.id,
				wait: true,
			});
			expect(finished.details.status).toBe("killed");
		} finally {
			await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
		}
	}, 2_000);
});
