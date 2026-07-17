import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerBetterNativeBash from "../better-native-pi/bash";
import registerBackgroundJobs, { BoundedOutput, CursorOutput } from "./index";
import { isPtySupported } from "./terminal-process";

interface Harness {
	tools: Map<string, any>;
	activeTools: Set<string>;
	commands: Map<string, any>;
	handlers: Map<string, (...args: any[]) => any>;
	statuses: Map<string, string | undefined>;
	selectCalls: Array<{ title: string; options: string[] }>;
	notifications: Array<{ message: string; level: string | undefined }>;
	events: Array<{ name: string; payload: any }>;
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
	const activeTools = new Set<string>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const statuses = new Map<string, string | undefined>();
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const events: Array<{ name: string; payload: any }> = [];
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		ui: {
			confirm: async () => true,
			notify(message: string, level?: string) { notifications.push({ message, level }); },
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			select: async (title: string, options: string[]) => {
				selectCalls.push({ title, options });
				return undefined;
			},
		},
		sessionManager: { getEntries: () => [] },
	};
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); activeTools.add(definition.name); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools.clear(); for (const name of names) activeTools.add(name); },
		registerEntryRenderer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		appendEntry() {},
		events: { emit(name: string, payload: any) { events.push({ name, payload }); } },
	};
	registerBackgroundJobs(pi as any, options);
	registerBetterNativeBash(pi as any);
	return { tools, activeTools, commands, handlers, statuses, selectCalls, notifications, events, ctx };
}

async function startHarness(harness: Harness): Promise<void> {
	await harness.handlers.get("session_start")?.({}, harness.ctx);
}

async function shutdownHarness(harness: Harness): Promise<void> {
	await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 150; attempt += 1) {
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

describe("bounded terminal output", () => {
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

	test("includes its omission marker inside the byte limit", () => {
		const output = new BoundedOutput();
		output.append(Buffer.alloc(16 * 1024, "h"));
		output.append(Buffer.alloc(20 * 1024, "t"));

		const text = output.text(24 * 1024);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24 * 1024);
		expect(text).toContain("earlier bytes omitted");
		expect(text.endsWith("t")).toBe(true);
	});

	test("reads only bytes added after a cursor", () => {
		const output = new CursorOutput();
		output.append("first\n");
		const first = output.read(0, 1024);
		output.append("second\n");
		const second = output.read(first.cursor, 1024);

		expect(first.text).toBe("first\n");
		expect(second.text).toBe("second\n");
		expect(second.cursor).toBe(output.cursor);
	});
});

describe("terminal tools", () => {
	test("registers only unified terminal APIs", async () => {
		const harness = createHarness();
		await startHarness(harness);
		expect([...harness.tools.keys()]).toEqual([
			"job_output",
			"terminal_write",
			"job_kill",
			"bash",
		]);
		expect([...harness.commands.keys()]).toEqual(["jobs", "ps"]);
		expect([...harness.activeTools]).toContain("bash");
		const bash = harness.tools.get("bash");
		expect(bash.parameters.properties.tty).toMatchObject({ type: "boolean" });
		expect(bash.parameters.properties["yield-time_ms"]).toMatchObject({ minimum: 250, maximum: 30_000 });
		expect(bash.description).toContain("prompts and REPLs");
		for (const name of ["job_output", "terminal_write"]) {
			const tool = harness.tools.get(name);
			expect(Object.keys(tool.parameters.properties)[0]).toBe("reasoning");
			expect(tool.parameters.required).toContain("reasoning");
		}
	});

	test("requires integer timeout seconds in schema and execution", async () => {
		const harness = createHarness();
		await startHarness(harness);
		const tool = harness.tools.get("bash");
		expect(tool.parameters.properties.timeout).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 86_400,
		});
		await expect(tool.execute("start", {
			command: "true",
			reasoning: "validate timeout",
			timeout: 0.5,
		}, undefined, undefined, harness.ctx)).rejects.toThrow("must be an integer between 1 and 86400");
	});

	test("returns quick commands normally and clears persistent status", async () => {
		const harness = createHarness();
		await startHarness(harness);
		const tool = harness.tools.get("bash");
		const args = {
			command: "printf 'quick-output'",
			reasoning: "test quick execution",
		};
		const result = await tool.execute("exec", args, undefined, undefined, harness.ctx);

		expect(result.details.status).toBe("completed");
		expect(result.content[0].text).toContain("quick-output");
		expect(harness.statuses.get("background-jobs")).toBeUndefined();
		expect(harness.events).toHaveLength(0);
		expect(harness.notifications).toHaveLength(0);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const rendered = tool.renderResult(result, { expanded: false }, theme, {
			state: {}, args, cwd: harness.ctx.cwd, invalidate() {},
		}).render(120).join("\n");
		expect(rendered).toContain("quick-output");
		expect(rendered).not.toContain(result.details.id);
	});

	test("yields long commands without notifying before the turn settles", async () => {
		const harness = createHarness();
		await startHarness(harness);
		await harness.handlers.get("agent_start")?.({});
		const started = await harness.tools.get("bash").execute("exec", {
			command: "printf 'first\\n'; sleep 0.4; printf 'second\\n'",
			reasoning: "test unified yielding",
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		expect(started.details.status).toBe("running");
		expect(started.content[0].text).toContain("first");
		expect(harness.statuses.get("background-jobs")).toContain("1 background job running");

		const finished = await harness.tools.get("terminal_write").execute("poll", {
			job_id: started.details.id,
			chars: "",
			"yield-time_ms": 1_000,
		});
		expect(finished.details.status).toBe("completed");
		expect(finished.content[0].text).toContain("second");
		expect(finished.content[0].text).not.toContain("\nfirst");
		expect(harness.events).toHaveLength(0);
		expect(harness.notifications).toHaveLength(0);

		const empty = await harness.tools.get("job_output").execute("output", {
			job_id: started.details.id,
		});
		expect(empty.content[0].text).toContain("no new output");
	});

	test("notifies when a yielded command finishes after the turn settles", async () => {
		const harness = createHarness();
		await startHarness(harness);
		await harness.handlers.get("agent_start")?.({});
		const started = await harness.tools.get("bash").execute("exec", {
			command: "sleep 0.4; printf 'late completion\\n'",
			reasoning: "test post-turn notification",
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		expect(started.details.status).toBe("running");

		await harness.handlers.get("agent_settled")?.({});
		const finished = await harness.tools.get("job_output").execute("wait", {
			reasoning: "wait for post-turn completion",
			job_id: started.details.id,
			wait: true,
		});
		expect(finished.details.status).toBe("completed");
		expect(harness.events).toHaveLength(1);
		expect(harness.events[0]?.payload.title).toContain("background job completed");
		expect(harness.notifications).toHaveLength(1);
	});

	test("writes stdin to a running non-PTY command", async () => {
		const harness = createHarness();
		await startHarness(harness);
		const started = await harness.tools.get("bash").execute("exec", {
			command: "read -r value; printf 'got:%s\\n' \"$value\"",
			reasoning: "test terminal input",
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		expect(started.details.status).toBe("running");

		const result = await harness.tools.get("terminal_write").execute("write", {
			reasoning: "answer the test prompt",
			job_id: started.details.id,
			chars: "hello\n",
			"yield-time_ms": 1_000,
		});
		expect(result.details.status).toBe("completed");
		expect(result.content[0].text).toContain("got:hello");
		const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
		const rendered = harness.tools.get("terminal_write").renderResult(
			result,
			{ expanded: false },
			theme,
			{ args: { reasoning: "answer the test prompt", job_id: started.details.id, chars: "hello\n" } },
		).render(200).join("\n");
		expect(rendered).toContain("<success>•</success> Interacted with <dim>");
		expect(rendered).toContain("</dim> <dim>to</dim> <accent>answer the test prompt</accent>");
		expect(rendered).toContain("│ </dim>got:hello");
		expect(rendered).not.toContain("↪");
		expect(rendered).not.toContain("↳");
	});

	test("updates the original running card when the command completes", async () => {
		const harness = createHarness();
		await startHarness(harness);
		const tool = harness.tools.get("bash");
		const args = {
			command: "printf 'styled-output\\n'; sleep 0.4",
			reasoning: "test live card",
			"yield-time_ms": 250,
		};
		const started = await tool.execute("start", args, undefined, undefined, harness.ctx);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const context = { state: {}, args, cwd: harness.ctx.cwd, invalidate() {} };
		const component = tool.renderResult(started, { expanded: false }, theme, context);
		const running = component.render(120).join("\n");
		expect(running).toContain("Running test live card");
		expect(running).toContain("╭ bash ");
		expect(running).toContain("  │ styled-output");
		expect(running).toContain("running · /ps");
		expect(running).not.toContain(`\n● ${started.details.id} · running`);

		await harness.tools.get("job_output").execute("wait", {
			job_id: started.details.id,
			wait: true,
		});
		const completed = component.render(120).join("\n");
		expect(completed).toContain("Ran test live card");
		expect(completed).toContain(`✓ ${started.details.id} · completed`);
		expect(completed).not.toContain("/ps");
		component.dispose?.();
	});

	test("keeps tool output below Pi's 50KB limit", async () => {
		const harness = createHarness();
		await startHarness(harness);
		const result = await harness.tools.get("bash").execute("exec", {
			command: "yes x | head -c 100000",
			reasoning: "test output limit",
		}, undefined, undefined, harness.ctx);
		expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(50 * 1024);
		expect(result.content[0].text).toContain("bytes omitted");
	});
});

describe("background terminal UX", () => {
	test("shows recent output in /ps and supports stop all", async () => {
		const harness = createHarness({ killGraceMs: 50 });
		await startHarness(harness);
		await harness.tools.get("bash").execute("one", {
			command: "printf 'recent-one\\n'; sleep 2",
			description: "first terminal",
			reasoning: "test dashboard",
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		await harness.tools.get("bash").execute("two", {
			command: "printf 'recent-two\\n'; sleep 2",
			description: "second terminal",
			reasoning: "test dashboard",
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		await Bun.sleep(50);

		await harness.commands.get("ps").handler("", harness.ctx);
		const list = harness.selectCalls.at(-1);
		expect(list?.title).toContain("2 running");
		expect(list?.options.join("\n")).toContain("recent-one");
		expect(list?.options.join("\n")).toContain("recent-two");

		await harness.commands.get("jobs").handler("stop all", harness.ctx);
		expect(harness.statuses.get("background-jobs")).toContain("2 background jobs running");
		await shutdownHarness(harness);
		expect(harness.statuses.get("background-jobs")).toBeUndefined();
	}, 3_000);

	test("waits for SIGKILL escalation during shutdown", async () => {
		if (process.platform === "win32") return;
		const directory = await mkdtemp(join(tmpdir(), "pi-background-jobs-"));
		const pidFile = join(directory, "pid");
		const harness = createHarness({ killGraceMs: 30 });
		await startHarness(harness);
		try {
			await harness.tools.get("bash").execute("start", {
				command: `trap '' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done`,
				reasoning: "test shutdown cleanup",
				"yield-time_ms": 250,
			}, undefined, undefined, harness.ctx);
			const pid = await waitForPid(pidFile);
			cleanupGroups.add(pid);
			await shutdownHarness(harness);
			await Bun.sleep(20);
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
		const started = await harness.tools.get("bash").execute("start", {
			command: "trap '' TERM; while :; do sleep 1; done",
			reasoning: "test timeout stop race",
			timeout: 1,
			"yield-time_ms": 250,
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
			await shutdownHarness(harness);
		}
	}, 3_000);

	test("makes repeated stop requests idempotent", async () => {
		if (process.platform === "win32") return;
		const harness = createHarness({ killGraceMs: 50 });
		await startHarness(harness);
		const started = await harness.tools.get("bash").execute("start", {
			command: "trap '' TERM; while :; do sleep 1; done",
			reasoning: "test duplicate stop requests",
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		try {
			await Bun.sleep(50);
			const first = await harness.tools.get("job_kill").execute("kill-1", { job_id: started.details.id }, undefined, undefined, harness.ctx);
			const second = await harness.tools.get("job_kill").execute("kill-2", { job_id: started.details.id }, undefined, undefined, harness.ctx);
			expect(first.content[0].text).toContain("Sent SIGTERM");
			expect(second.content[0].text).toContain("Stop already requested");
			const finished = await harness.tools.get("job_output").execute("output", { job_id: started.details.id, wait: true });
			expect(finished.details.status).toBe("killed");
		} finally {
			await shutdownHarness(harness);
		}
	}, 2_000);
});

describe("PTY terminals", () => {
	test("supports interactive input and Ctrl+C", async () => {
		if (!isPtySupported()) return;
		const harness = createHarness({ killGraceMs: 100 });
		await startHarness(harness);
		const prompt = await harness.tools.get("bash").execute("pty", {
			command: "read -r value; printf 'got:%s\\n' \"$value\"; trap 'echo interrupted; exit 0' INT; while :; do sleep 1; done",
			reasoning: "test PTY interaction",
			tty: true,
			"yield-time_ms": 250,
		}, undefined, undefined, harness.ctx);
		try {
			const input = await harness.tools.get("terminal_write").execute("write", {
				job_id: prompt.details.id,
				chars: "hello\n",
				"yield-time_ms": 500,
			});
			expect(input.content[0].text).toContain("got:hello");
			const interrupted = await harness.tools.get("terminal_write").execute("interrupt", {
				job_id: prompt.details.id,
				chars: "\u0003",
				"yield-time_ms": 1_000,
			});
			expect(interrupted.content[0].text).toContain("interrupted");
			expect(interrupted.details.status).toBe("completed");
		} finally {
			await shutdownHarness(harness);
		}
	}, 4_000);

	test("kills the PTY child process tree on shutdown", async () => {
		if (!isPtySupported() || process.platform === "win32") return;
		const directory = await mkdtemp(join(tmpdir(), "pi-background-pty-"));
		const pidFile = join(directory, "pid");
		const harness = createHarness({ killGraceMs: 40 });
		await startHarness(harness);
		try {
			await harness.tools.get("bash").execute("pty", {
				command: `trap '' TERM HUP; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done`,
				reasoning: "test PTY shutdown cleanup",
				tty: true,
				"yield-time_ms": 250,
			}, undefined, undefined, harness.ctx);
			const pid = await waitForPid(pidFile);
			cleanupGroups.add(pid);
			await shutdownHarness(harness);
			await Bun.sleep(30);
			expect(processGroupExists(pid)).toBe(false);
			cleanupGroups.delete(pid);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 3_000);
});
