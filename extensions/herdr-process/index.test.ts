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
			["pane", "split", "--current", "--direction", "right", "--cwd", "/repo", "--no-focus"],
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
		const harness = createHarness({
			entries,
			exec: async (_command, args) => args[1] === "process-info"
				? ok(JSON.stringify({ result: { process_info: { foreground_processes: [] } } }))
				: ok(),
		});
		await harness.start();
		const listed = await harness.tools.get("herdr_process").execute("list", {
			reasoning: "find visible processes",
			action: "list",
		}, undefined, undefined, harness.ctx);
		expect(listed.content[0].text).toBe("w1:p8 — api server");
		await expect(harness.tools.get("herdr_process").execute("status", {
			reasoning: "check API server",
			action: "status",
			pane_id: "w1:p8",
		}, undefined, undefined, harness.ctx)).resolves.toMatchObject({ details: { paneId: "w1:p8" } });
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
