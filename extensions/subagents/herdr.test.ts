import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	childSessionName,
	HerdrAgentClient,
	HerdrSurfaceManager,
	responsiveSplitDirection,
	subagentsTabLabel,
	subscribeTerminalResize,
	type ExecResult,
	type HerdrPaneLayout,
} from "./herdr";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

function success(result: unknown): ExecResult {
	return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
}

function layout(
	width: number,
	height: number,
	panes: HerdrPaneLayout["panes"],
	tabId = "tab-parent",
): HerdrPaneLayout {
	return {
		workspace_id: "workspace-1",
		tab_id: tabId,
		zoomed: false,
		area: { x: 0, y: 0, width, height },
		panes,
	};
}

describe("Herdr subagent surfaces", () => {
	test("makes parent and child session roles explicit and chooses layouts with hysteresis", () => {
		expect(subagentsTabLabel("Crawler Review")).toBe("Subagents · Crawler Review");
		expect(subagentsTabLabel(undefined)).toBe("Subagents · Untitled Session");
		expect(subagentsTabLabel("x".repeat(100))).toHaveLength(80);
		expect(childSessionName("reviewer")).toBe("Subagent · reviewer");
		const wide = layout(240, 80, []);
		const narrow = layout(120, 80, []);
		expect(responsiveSplitDirection(wide)).toBe("right");
		expect(responsiveSplitDirection(narrow)).toBe("down");
		expect(responsiveSplitDirection(layout(165, 90, []), "right")).toBe("right");
		expect(responsiveSplitDirection(layout(165, 90, []), "down")).toBe("down");
	});

	test("serializes concurrent children into one adaptive region in the parent tab", async () => {
		const calls: string[][] = [];
		let nextPane = 1;
		let subscribed = 0;
		const manager = new HerdrSurfaceManager(async (_command, args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "layout") {
				if (args[3] === "parent-pane") {
					return success({ layout: layout(240, 80, [{ pane_id: "parent-pane", rect: { x: 0, y: 0, width: 240, height: 80 } }]) });
				}
				return success({
					layout: layout(240, 80, [
						{ pane_id: "parent-pane", rect: { x: 0, y: 0, width: 160, height: 80 } },
						{ pane_id: "pane-1", rect: { x: 160, y: 0, width: 80, height: 80 } },
					]),
				});
			}
			if (args[0] === "pane" && args[1] === "split") return success({ pane: { pane_id: `pane-${nextPane++}` } });
			return success({});
		}, "workspace-1", "parent-pane", () => {
			subscribed += 1;
			return () => { subscribed -= 1; };
		});
		const reviewer = { agentId: "a", name: "reviewer" };
		const tester = { agentId: "b", name: "tester" };

		const [first, second] = await Promise.all([
			manager.ensurePane(reviewer, "/repo"),
			manager.ensurePane(tester, "/repo"),
		]);

		expect([first, second]).toEqual(["pane-1", "pane-2"]);
		expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(0);
		expect(calls.filter((args) => args[0] === "pane" && args[1] === "split")).toEqual([
			["pane", "split", "parent-pane", "--direction", "right", "--ratio", "0.67", "--cwd", "/repo", "--no-focus"],
			["pane", "split", "pane-1", "--direction", "down", "--ratio", "0.5", "--cwd", "/repo", "--no-focus"],
		]);
		expect(calls.filter((args) => args[0] === "pane" && args[1] === "rename")).toEqual([
			["pane", "rename", "pane-1", "reviewer"],
			["pane", "rename", "pane-2", "tester"],
		]);
		expect(subscribed).toBe(1);

		await manager.closePane(reviewer);
		expect(subscribed).toBe(1);
		await manager.closePane(tester);
		expect(subscribed).toBe(0);
	});

	test("reflows owned panes after scoped debounced resize events", async () => {
		const calls: string[][] = [];
		let listener: (() => void) | undefined;
		let unsubscribed = 0;
		let currentLayout = layout(240, 80, [
			{ pane_id: "parent-pane", rect: { x: 0, y: 0, width: 240, height: 80 } },
		]);
		const manager = new HerdrSurfaceManager(async (_command, args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "layout") return success({ layout: currentLayout });
			if (args[0] === "pane" && args[1] === "split") return success({ pane: { pane_id: "pane-1" } });
			if (args[0] === "pane" && args[1] === "move" && args.includes("--new-tab")) {
				return success({ move_result: { changed: true, pane: { pane_id: "pane-1", tab_id: "tab-stage" }, created_tab: { tab_id: "tab-stage" } } });
			}
			if (args[0] === "pane" && args[1] === "move") {
				return success({ move_result: { changed: true, pane: { pane_id: "pane-1", tab_id: "tab-parent" } } });
			}
			return success({});
		}, "workspace-1", "parent-pane", (next) => {
			listener = next;
			return () => { unsubscribed += 1; listener = undefined; };
		});
		const reviewer = { agentId: "a", name: "reviewer" };
		await manager.ensurePane(reviewer, "/repo");

		currentLayout = layout(120, 80, [
			{ pane_id: "parent-pane", rect: { x: 0, y: 0, width: 120, height: 54 } },
			{ pane_id: "pane-1", rect: { x: 0, y: 54, width: 120, height: 26 } },
		]);
		listener?.();
		listener?.();
		await Bun.sleep(350);
		const moves = calls.filter((args) => args[0] === "pane" && args[1] === "move");
		expect(moves).toEqual([
			["pane", "move", "pane-1", "--new-tab", "--workspace", "workspace-1", "--label", "Reflowing subagents", "--no-focus"],
			["pane", "move", "pane-1", "--tab", "tab-parent", "--target-pane", "parent-pane", "--split", "down", "--ratio", "0.67", "--no-focus"],
		]);

		await manager.closePane(reviewer);
		expect(unsubscribed).toBe(1);
	});

	test("falls back to a named tab instead of resizing unrelated panes", async () => {
		const calls: string[][] = [];
		let tabLabel = "Subagents · Parent Review";
		const manager = new HerdrSurfaceManager(async (_command, args) => {
			calls.push(args);
			if (args[0] === "pane" && args[1] === "layout") {
				return success({
					layout: layout(240, 80, [
						{ pane_id: "parent-pane", rect: { x: 0, y: 0, width: 160, height: 80 } },
						{ pane_id: "user-pane", rect: { x: 160, y: 0, width: 80, height: 80 } },
					]),
				});
			}
			if (args[0] === "tab" && args[1] === "create") {
				return success({ tab: { tab_id: "tab-agents" }, root_pane: { pane_id: "pane-1" } });
			}
			return success({});
		}, "workspace-1", "parent-pane", undefined, () => tabLabel);
		const state = { agentId: "a", name: "reviewer" };
		await expect(manager.ensurePane(state, "/repo")).resolves.toBe("pane-1");
		expect(calls.find((args) => args[0] === "tab" && args[1] === "create")).toEqual([
			"tab", "create", "--workspace", "workspace-1", "--cwd", "/repo",
			"--label", "Subagents · Parent Review", "--no-focus",
		]);

		tabLabel = "Subagents · Renamed Parent";
		await manager.refreshTabLabel();
		expect(calls.at(-1)).toEqual(["tab", "rename", "tab-agents", "Subagents · Renamed Parent"]);
	});

	test("subscribes to native terminal resize events until disposed", () => {
		const output = new EventEmitter();
		let resizes = 0;
		const unsubscribe = subscribeTerminalResize(() => { resizes += 1; }, output);
		output.emit("resize");
		expect(resizes).toBe(1);
		unsubscribe();
		output.emit("resize");
		expect(resizes).toBe(1);
	});

	test("treats the pane shell as idle after a child exits", async () => {
		const manager = new HerdrSurfaceManager(async (_command, args) => {
			expect(args).toEqual(["pane", "process-info", "--pane", "pane-1"]);
			return success({
				process_info: {
					shell_pid: 42,
					foreground_processes: [{ pid: 84, name: "zsh", argv: ["zsh", "-l"] }],
				},
			});
		}, "workspace-1", "parent-pane");
		await expect(manager.waitUntilIdle("pane-1")).resolves.toBe(true);
	});

	test("accepts Herdr pane run success without JSON output", async () => {
		const manager = new HerdrSurfaceManager(async (_command, args) => {
			expect(args).toEqual(["pane", "run", "pane-1", "echo ok"]);
			return { code: 0, stdout: "", stderr: "" };
		}, "workspace-1", "parent-pane");
		await expect(manager.runCommand("pane-1", "echo ok")).resolves.toBeUndefined();
	});

	test("controls a visible child through IPC without reading its pane", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-herdr-client-test-"));
		cleanup.push(() => rm(directory, { recursive: true, force: true }));
		let command = "";
		let launcherContents = "";
		let interrupted = false;
		const surfaces = {
			async ensurePane(state: any) { state.paneId = "pane-visible"; return state.paneId; },
			async runCommand(_paneId: string, value: string) {
				command = value;
				const launcherPath = value.match(/^'([^']+)'$/)?.[1];
				if (!launcherPath) throw new Error("missing private launcher path");
				const launcher = await readFile(launcherPath, "utf8");
				launcherContents = launcher;
				const socketPath = launcher.match(/PI_SUBAGENT_BRIDGE_SOCKET='([^']+)'/)?.[1];
				const token = launcher.match(/PI_SUBAGENT_BRIDGE_TOKEN='([^']+)'/)?.[1];
				const agentId = launcher.match(/PI_SUBAGENT_PARENT_ID='([^']+)'/)?.[1];
				if (!socketPath || !token || !agentId) throw new Error("missing bridge environment");
				const socket = net.createConnection(socketPath);
				let buffer = "";
				socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", token, agentId })}\n`));
				socket.on("data", (chunk) => {
					buffer += chunk.toString();
					for (;;) {
						const newline = buffer.indexOf("\n");
						if (newline < 0) break;
						const request = JSON.parse(buffer.slice(0, newline));
						buffer = buffer.slice(newline + 1);
						socket.write(`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true })}\n`);
						if (request.type === "prompt") {
							socket.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Visible result" }] } })}\n`);
						}
						if (request.type === "shutdown") queueMicrotask(() => socket.end());
					}
				});
			},
			async interrupt() { interrupted = true; },
			async waitUntilIdle() { return true; },
			async closePane() {},
		};
		const client = new HerdrAgentClient({
			command: "pi",
			args: ["--session", join(directory, "context.jsonl"), "--name", "reviewer"],
			cwd: "/repo",
			env: { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_ID: "reviewer-1" },
			herdr: { agentId: "reviewer-1", name: "reviewer" },
		}, surfaces as any);
		const events: any[] = [];
		client.onEvent((event) => events.push(event));

		await client.start();
		await client.prompt("Inspect the code");
		await Bun.sleep(0);
		expect(command).toMatch(/pi-subagent-bridge-.+\/run-child/);
		expect(command).not.toContain("PI_SUBAGENT_BRIDGE_TOKEN");
		expect(launcherContents).toContain("'--name' 'reviewer'");
		expect(launcherContents).toContain('exec "${SHELL:-/bin/sh}" -l');
		expect(events).toContainEqual(expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "assistant" }) }));
		await client.stop();
		expect(interrupted).toBe(false);
	});
});
