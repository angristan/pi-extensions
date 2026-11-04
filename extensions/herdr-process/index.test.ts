import { describe, expect, test } from "bun:test";
import registerHerdrProcess from "./index";

interface ExecCall {
	command: string;
	args: string[];
	options?: { signal?: AbortSignal; timeout?: number };
}

function ok(stdout = "") {
	return { stdout, stderr: "", code: 0 };
}

function createHarness(options: {
	env?: NodeJS.ProcessEnv;
	mode?: string;
	entries?: any[];
	exec?: (command: string, args: string[], options?: any) => Promise<any>;
} = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const calls: ExecCall[] = [];
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/repo",
		sessionManager: {
			getBranch: () => options.entries ?? [],
		},
	};
	const exec = options.exec ?? (async (command: string, args: string[], execOptions?: any) => {
		calls.push({ command, args, options: execOptions });
		if (args[0] === "pane" && args[1] === "layout") {
			return ok(JSON.stringify({
				result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 150, height: 60 } }] } },
			}));
		}
		if (args[0] === "pane" && args[1] === "split") {
			return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
		}
		return ok();
	});
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const existing = handlers.get(name) ?? [];
			existing.push(handler);
			handlers.set(name, existing);
		},
		exec,
	};
	registerHerdrProcess(pi as any, {
		env: options.env ?? { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
		exec,
	});
	const start = async () => {
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	};
	return { tools, handlers, calls, ctx, start };
}

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

describe("herdr-process", () => {
	test("registers only in a Herdr-managed TUI", async () => {
		const outside = createHarness({ env: {} });
		await outside.start();
		expect(outside.tools.size).toBe(0);

		const headless = createHarness({ mode: "print" });
		await headless.start();
		expect(headless.tools.size).toBe(0);

		const tui = createHarness();
		expect(tui.tools.size).toBe(0);
		await tui.start();
		expect([...tui.tools.keys()]).toEqual(["herdr_process"]);
		const tool = tui.tools.get("herdr_process");
		expect(tool.promptSnippet).toBeUndefined();
		const guidelines = tool.promptGuidelines as string[];
		expect(guidelines).toEqual([
			"Keep Herdr processes in the foreground. Use herdr_process action=interrupt to stop one. After its work and any needed output are done, close its idle pane with action=close; start a fresh pane for later work.",
		]);
		expect(guidelines.join(" ")).not.toContain("instead of bash");
	});

	test("starts a labeled command in an automatically placed sibling pane", async () => {
		const harness = createHarness();
		await harness.start();
		const tool = harness.tools.get("herdr_process");
		const result = await tool.execute("start", {
			reasoning: "show development logs",
			action: "start",
			command: "bun run dev",
			label: "frontend dev server",
		}, undefined, undefined, harness.ctx);

		expect(harness.calls.map((call) => call.args)).toEqual([
			["pane", "layout", "--current"],
			["pane", "split", "--current", "--direction", "right", "--ratio", "0.67", "--cwd", "/repo", "--no-focus"],
			["pane", "rename", "w1:p2", "frontend dev server"],
			["pane", "run", "w1:p2", "bun run dev"],
		]);
		expect(harness.calls.every((call) => call.command === "herdr" && call.options?.timeout === 5_000)).toBe(true);
		expect(result).toMatchObject({
			content: [{ text: "Started frontend dev server in visible Herdr pane w1:p2." }],
			details: {
				herdrProcess: true,
				action: "start",
				paneId: "w1:p2",
				label: "frontend dev server",
				command: "bun run dev",
				cwd: "/repo",
				direction: "right",
			},
		});
	});

	test("splits down when the current pane is narrow", async () => {
		const calls: ExecCall[] = [];
		const harness = createHarness({
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				if (args[1] === "layout") {
					return ok(JSON.stringify({ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 90, height: 55 } }] } } }));
				}
				if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }));
				return ok();
			},
		});
		await harness.start();
		await harness.tools.get("herdr_process").execute("start", {
			reasoning: "watch tests",
			action: "start",
			command: "bun test --watch",
		}, undefined, undefined, harness.ctx);
		expect(calls[1]?.args).toContain("down");
	});

	test("later starts split the largest owned pane, never Pi or user panes", async () => {
		const calls: ExecCall[] = [];
		let pane = 1;
		// w1:p1 is Pi, w1:u1 belongs to the user, w1:p2/w1:p3 are created here.
		const rects: Record<string, { width: number; height: number }> = {
			"w1:p1": { width: 100, height: 60 },
			"w1:u1": { width: 200, height: 60 },
		};
		const harness = createHarness({
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				if (args[1] === "layout") {
					const panes = Object.entries(rects).map(([pane_id, rect]) => ({ pane_id, rect }));
					return ok(JSON.stringify({ result: { layout: { panes } } }));
				}
				if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: `w1:p${++pane}` } } }));
				return ok();
			},
		});
		await harness.start();
		const tool = harness.tools.get("herdr_process");
		const start = (label: string) => tool.execute("start", {
			reasoning: `show ${label}`, action: "start", command: label, label,
		}, undefined, undefined, harness.ctx);

		await start("server");
		rects["w1:p2"] = { width: 50, height: 60 };
		await start("watcher");
		rects["w1:p2"] = { width: 50, height: 20 };
		rects["w1:p3"] = { width: 50, height: 40 };
		await start("logs");

		const splits = calls.filter((call) => call.args[1] === "split").map((call) => call.args.slice(2, -3));
		expect(splits).toEqual([
			["--current", "--direction", "down", "--ratio", "0.67"],
			["--pane", "w1:p2", "--direction", "down"],
			["--pane", "w1:p3", "--direction", "down"],
		]);
	});

	test("falls back to Pi's pane when the owned pane vanished", async () => {
		const entries = [{ type: "message", message: { role: "toolResult", toolName: "herdr_process", details: {
			herdrProcess: true, action: "start", paneId: "w1:p8", label: "api", command: "bun run api", cwd: "/repo", direction: "right",
		} } }];
		const calls: ExecCall[] = [];
		const harness = createHarness({
			entries,
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				if (args[1] === "layout") return ok("not-json");
				if (args[1] === "split" && args.includes("w1:p8")) {
					return { stdout: JSON.stringify({ error: { code: "pane_not_found" } }), stderr: "", code: 1 };
				}
				if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }));
				return ok();
			},
		});
		await harness.start();
		const tool = harness.tools.get("herdr_process");
		await tool.execute("start", { reasoning: "run tests", action: "start", command: "bun test" }, undefined, undefined, harness.ctx);
		const splits = calls.filter((call) => call.args[1] === "split").map((call) => call.args.slice(2, -3));
		expect(splits).toEqual([
			["--pane", "w1:p8", "--direction", "down"],
			["--current", "--direction", "right", "--ratio", "0.67"],
		]);
		const listed = await tool.execute("list", { reasoning: "list", action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.content[0].text).toBe("w1:p9 — bun test");
	});

	test("reads, inspects, writes to, and interrupts a known pane", async () => {
		const calls: ExecCall[] = [];
		const harness = createHarness({
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				if (args[1] === "layout") return ok("not-json"); // falls back to right
				if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p4" } } }));
				if (args[1] === "read") {
					const source = args[args.indexOf("--source") + 1];
					return source === "visible" ? ok("ready\nrequest complete\n") : ok();
				}
				if (args[1] === "process-info") {
					return ok(JSON.stringify({ result: { process_info: { foreground_processes: [
						{ name: "bun", pid: 42, cmdline: "bun run dev" },
					] } } }));
				}
				return ok();
			},
		});
		await harness.start();
		const tool = harness.tools.get("herdr_process");
		await tool.execute("start", {
			reasoning: "show server",
			action: "start",
			command: "bun run dev",
			label: "server",
		}, undefined, undefined, harness.ctx);

		const read = await tool.execute("read", {
			reasoning: "inspect recent requests",
			action: "read",
			pane_id: "w1:p4",
			lines: 20,
		}, undefined, undefined, harness.ctx);
		expect(read.content[0].text).toBe("ready\nrequest complete\n");

		const status = await tool.execute("status", {
			reasoning: "check server state",
			action: "status",
			pane_id: "w1:p4",
		}, undefined, undefined, harness.ctx);
		expect(status.content[0].text).toBe("bun (PID 42): bun run dev");

		await tool.execute("input", {
			reasoning: "answer server prompt",
			action: "input",
			pane_id: "w1:p4",
			text: "yes",
		}, undefined, undefined, harness.ctx);
		await tool.execute("interrupt", {
			reasoning: "stop development server",
			action: "interrupt",
			pane_id: "w1:p4",
		}, undefined, undefined, harness.ctx);

		expect(calls.map((call) => call.args).slice(-6)).toEqual([
			["pane", "read", "w1:p4", "--source", "recent-unwrapped", "--lines", "20", "--format", "text"],
			["pane", "read", "w1:p4", "--source", "visible", "--lines", "20", "--format", "text"],
			["pane", "process-info", "--pane", "w1:p4"],
			["pane", "send-text", "w1:p4", "yes"],
			["pane", "send-keys", "w1:p4", "enter"],
			["pane", "send-keys", "w1:p4", "ctrl+c"],
		]);
	});

	test("refuses to inspect or control unknown panes", async () => {
		const harness = createHarness();
		await harness.start();
		await expect(harness.tools.get("herdr_process").execute("read", {
			reasoning: "inspect unrelated pane",
			action: "read",
			pane_id: "w9:p9",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("Refusing to control unknown pane w9:p9");
		expect(harness.calls).toHaveLength(0);
	});

	test("restores pane ownership from persisted tool results", async () => {
		const entries = [{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "herdr_process",
				details: {
					herdrProcess: true,
					action: "start",
					paneId: "w1:p8",
					label: "api server",
					command: "bun run api",
					cwd: "/repo",
					direction: "right",
				},
			},
		}];
		const calls: ExecCall[] = [];
		const harness = createHarness({
			entries,
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				if (args[1] === "process-info") return ok(JSON.stringify({ result: { process_info: { foreground_processes: [] } } }));
				if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }));
				return ok();
			},
		});
		await harness.start();
		const listed = await harness.tools.get("herdr_process").execute("list", {
			reasoning: "find visible processes",
			action: "list",
		}, undefined, undefined, harness.ctx);
		expect(listed.content[0].text).toBe("w1:p8 — api server");
		const tool = harness.tools.get("herdr_process");
		await expect(tool.execute("status", {
			reasoning: "check API server",
			action: "status",
			pane_id: "w1:p8",
		}, undefined, undefined, harness.ctx)).resolves.toMatchObject({ details: { paneId: "w1:p8" } });
		await tool.execute("start", {
			reasoning: "show test watcher",
			action: "start",
			command: "bun test --watch",
			label: "test watcher",
		}, undefined, undefined, harness.ctx);
		// The restored pane, not Pi's pane, is split for the next process.
		const split = calls.find((call) => call.args[1] === "split");
		expect(split?.args.slice(2, 4)).toEqual(["--pane", "w1:p8"]);
	});

	describe("close", () => {
		// Mirrors Herdr's process-info payload: the shell owns the foreground
		// process group when idle, and a child command owns it while running.
		const processInfo = (foregroundGroup: number, name: string) => ok(JSON.stringify({ result: { process_info: {
			shell_pid: 100,
			foreground_process_group_id: foregroundGroup,
			foreground_processes: [{ name, pid: foregroundGroup, cmdline: name }],
		} } }));
		const notFound = { stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane not found" } }), stderr: "", code: 1 };

		async function startedHarness(respond: (args: string[]) => any) {
			const calls: ExecCall[] = [];
			const harness = createHarness({
				exec: async (command, args, options) => {
					calls.push({ command, args, options });
					if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p5" } } }));
					return respond(args) ?? ok();
				},
			});
			await harness.start();
			const tool = harness.tools.get("herdr_process");
			await tool.execute("start", { reasoning: "run server", action: "start", command: "bun run dev", direction: "right" }, undefined, undefined, harness.ctx);
			const close = () => tool.execute("close", { reasoning: "clean up", action: "close", pane_id: "w1:p5" }, undefined, undefined, harness.ctx);
			const list = async () => (await tool.execute("list", { reasoning: "list", action: "list" }, undefined, undefined, harness.ctx)).content[0].text;
			return { calls, close, list };
		}

		test("closes an idle pane and releases ownership", async () => {
			const { calls, close, list } = await startedHarness((args) => args[1] === "process-info" ? processInfo(100, "zsh") : undefined);
			const result = await close();
			expect(result).toMatchObject({ content: [{ text: "Closed Herdr pane w1:p5." }], details: { action: "close", paneId: "w1:p5" } });
			expect(calls.some((call) => call.args.join(" ") === "pane close w1:p5")).toBe(true);
			expect(await list()).toBe("No Herdr process panes were started by this session.");
			await expect(close()).rejects.toThrow("Refusing to control unknown pane w1:p5");
		});

		test("refuses while a process runs and keeps the pane", async () => {
			const { calls, close, list } = await startedHarness((args) => args[1] === "process-info" ? processInfo(200, "bun") : undefined);
			await expect(close()).rejects.toThrow("use action=interrupt first");
			expect(calls.some((call) => call.args[1] === "close")).toBe(false);
			expect(await list()).toBe("w1:p5 — bun run dev");
		});

		test("treats unknown process state as busy", async () => {
			const { calls, close } = await startedHarness((args) => args[1] === "process-info"
				? ok(JSON.stringify({ result: { process_info: { foreground_processes: [] } } }))
				: undefined);
			await expect(close()).rejects.toThrow("Refusing to close");
			expect(calls.some((call) => call.args[1] === "close")).toBe(false);
		});

		test("releases a pane that is already gone", async () => {
			const { calls, close, list } = await startedHarness((args) => args[1] === "process-info" ? notFound : undefined);
			await expect(close()).resolves.toMatchObject({ content: [{ text: "Herdr pane w1:p5 is already gone." }] });
			expect(calls.some((call) => call.args[1] === "close")).toBe(false);
			expect(await list()).toBe("No Herdr process panes were started by this session.");
		});

		test("surfaces other Herdr failures without releasing the pane", async () => {
			const { close, list } = await startedHarness((args) => args[1] === "process-info"
				? { stdout: "", stderr: "server unavailable", code: 1 }
				: undefined);
			await expect(close()).rejects.toThrow("server unavailable");
			expect(await list()).toBe("w1:p5 — bun run dev");
		});

		test("persisted close results keep a closed pane released after reload", async () => {
			const result = (details: any) => ({ type: "message", message: { role: "toolResult", toolName: "herdr_process", details } });
			const harness = createHarness({ entries: [
				result({ herdrProcess: true, action: "start", paneId: "w1:p8", label: "api", command: "bun run api", cwd: "/repo", direction: "right" }),
				result({ herdrProcess: true, action: "close", paneId: "w1:p8", label: "api" }),
			] });
			await harness.start();
			await expect(harness.tools.get("herdr_process").execute("read", {
				reasoning: "read closed pane", action: "read", pane_id: "w1:p8",
			}, undefined, undefined, harness.ctx)).rejects.toThrow("Refusing to control unknown pane w1:p8");
		});
	});

	test("renders partial arguments before action arrives", async () => {
		const harness = createHarness();
		await harness.start();
		const tool = harness.tools.get("herdr_process");
		expect(tool.renderCall({}, theme, { isPartial: true }).render(120)).toEqual(["• Using Herdr process"]);
		expect(tool.renderCall(undefined, theme, { isPartial: true }).render(120)).toEqual(["• Using Herdr process"]);
		expect(tool.renderResult(
			{ content: [{ type: "text", text: "render failure" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ args: {}, isError: true },
		).render(120).join("\n")).toContain("Herdr process failed");
	});

	test("renders running and settled process rows", async () => {
		const harness = createHarness();
		await harness.start();
		const tool = harness.tools.get("herdr_process");
		const args = {
			reasoning: "show development logs",
			action: "start",
			command: "bun run dev",
			label: "frontend",
		};
		const call = tool.renderCall(args, theme, { isPartial: true }).render(120).join("\n");
		expect(call).toContain("Starting show development logs");
		expect(call).toContain("frontend");

		const result = tool.renderResult({
			content: [{ type: "text", text: "Started frontend in visible Herdr pane w1:p2." }],
			details: { herdrProcess: true, action: "start", paneId: "w1:p2", label: "frontend" },
		}, { expanded: false, isPartial: false }, theme, { args }).render(120).join("\n");
		expect(result).toContain("Started show development logs");
		expect(result).toContain("frontend · w1:p2");
	});
});
