import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BRIDGE_AGENT_ID_ENV, BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV } from "./bridge.js";
import type { AgentClient, AgentClientOptions, RpcAgentEvent } from "./rpc.js";

const HERDR_TIMEOUT_MS = 10_000;
const BRIDGE_START_TIMEOUT_MS = 30_000;
const BRIDGE_COMMAND_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const REFLOW_DEBOUNCE_MS = 250;
const LAYOUT_POLL_MS = 400;
const PRIMARY_PANE_RATIO = 0.67;
const REFLOW_TAB_LABEL = "Reflowing subagents";
const MAX_HERDR_LABEL_CHARS = 80;

export type SplitDirection = "right" | "down";

export interface HerdrLayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HerdrPaneLayout {
	workspace_id: string;
	tab_id: string;
	zoomed: boolean;
	area: HerdrLayoutRect;
	panes: Array<{ pane_id: string; rect: HerdrLayoutRect }>;
}

export type HerdrLayoutSubscriber = (listener: (layout: HerdrPaneLayout) => void) => () => void;

export function subagentsTabLabel(parentSessionName: string | undefined): string {
	const parent = parentSessionName?.replace(/\s+/g, " ").trim() || "Untitled Session";
	const label = `Subagents · ${parent}`;
	return label.length <= MAX_HERDR_LABEL_CHARS ? label : `${label.slice(0, MAX_HERDR_LABEL_CHARS - 1)}…`;
}

export function childSessionName(masterName: string): string {
	return `Subagent · ${masterName}`;
}

/**
 * Keep a little hysteresis between wide and narrow thresholds so a terminal
 * near the boundary does not repeatedly rebuild its pane tree while resizing.
 */
export function responsiveSplitDirection(layout: HerdrPaneLayout, current?: SplitDirection): SplitDirection {
	const width = Number(layout.area?.width ?? 0);
	const height = Math.max(1, Number(layout.area?.height ?? 0));
	const aspect = width / height;
	if (current === "right") return width <= 150 || aspect <= 1.7 ? "down" : "right";
	if (current === "down") return width >= 180 && aspect >= 2.1 ? "right" : "down";
	return width >= 165 && aspect >= 1.9 ? "right" : "down";
}

/**
 * Watch one parent layout only while its surface manager needs it. Herdr 0.8.2
 * does not emit layout events for outer terminal resizes and processes one API
 * request per connection, so each low-frequency poll uses a short local socket.
 */
export function watchHerdrLayout(
	socketPath: string,
	paneId: string,
	listener: (layout: HerdrPaneLayout) => void,
	pollIntervalMs = LAYOUT_POLL_MS,
): () => void {
	let disposed = false;
	let socket: Socket | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let nextRequestId = 0;

	const poll = () => {
		if (disposed || socket) return;
		const requestId = `subagents-layout-poll-${++nextRequestId}`;
		let buffer = "";
		const decoder = new StringDecoder("utf8");
		const current = net.createConnection(socketPath);
		socket = current;
		current.setNoDelay(true);
		current.setTimeout(HERDR_TIMEOUT_MS, () => current.destroy());
		current.once("connect", () => {
			current.write(`${JSON.stringify({
				id: requestId,
				method: "pane.layout",
				params: { pane_id: paneId },
			})}\n`);
		});
		current.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			if (Buffer.byteLength(buffer) > MAX_RECORD_BYTES) {
				current.destroy(new Error("Herdr pane layout response exceeded the size limit"));
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const message = JSON.parse(buffer.slice(0, newline));
				if (!disposed && message?.id === requestId && message?.result?.layout) listener(message.result.layout);
			} catch { /* A later poll retries malformed responses. */ }
			current.destroy();
		});
		current.on("error", () => { /* A later poll retries transient socket errors. */ });
		current.once("close", () => {
			if (socket === current) socket = undefined;
		});
	};

	poll();
	pollTimer = setInterval(poll, pollIntervalMs);
	pollTimer.unref?.();
	return () => {
		disposed = true;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		socket?.destroy();
		socket = undefined;
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

export type HerdrExec = (
	command: string,
	args: string[],
	options: { timeout: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface HerdrSurfaceState {
	agentId: string;
	name: string;
	paneId?: string;
}

export interface HerdrAgentClientOptions extends AgentClientOptions {
	herdr: HerdrSurfaceState;
}

function parseResult(result: ExecResult, operation: string): any {
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout || `exit code ${result.code ?? "unknown"}`).trim().slice(0, 2_000);
		throw new Error(`Herdr ${operation} failed: ${detail}`);
	}
	try { return JSON.parse(result.stdout); }
	catch { throw new Error(`Herdr ${operation} returned invalid JSON`); }
}

function isInteractiveShell(process: any): boolean {
	const name = String(process?.name ?? "").toLowerCase();
	return ["bash", "dash", "fish", "nu", "sh", "zsh"].includes(name);
}

function isMissingPaneError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /(?:unknown|missing|not found|does not exist).*pane|pane.*(?:unknown|missing|not found|does not exist)/i.test(message);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function launcherScript(options: HerdrAgentClientOptions, socketPath: string, token: string): string {
	const env = {
		...options.env,
		[BRIDGE_SOCKET_ENV]: socketPath,
		[BRIDGE_TOKEN_ENV]: token,
		[BRIDGE_AGENT_ID_ENV]: options.herdr.agentId,
	};
	return [
		"#!/bin/sh",
		...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
		[shellQuote(options.command), ...options.args.map(shellQuote)].join(" "),
		// `pane run` owns the pane process. Return to an interactive shell after
		// Pi exits so completed output remains visible and follow-ups can reuse it.
		'exec "${SHELL:-/bin/sh}" -l',
		"",
	].join("\n");
}

/** Owns responsive child panes beside the Pi pane that created this manager. */
export class HerdrSurfaceManager {
	private readonly surfaces = new Map<string, HerdrSurfaceState>();
	private parentTabId?: string;
	private dedicatedTabId?: string;
	private currentDirection?: SplitDirection;
	private unsubscribeLayouts?: () => void;
	private reflowTimer?: ReturnType<typeof setTimeout>;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly exec: HerdrExec,
		private readonly workspaceId: string,
		private readonly parentPaneId: string,
		private readonly subscribeLayouts?: HerdrLayoutSubscriber,
		private readonly tabLabel: () => string = () => "Subagents",
	) {}

	private async execute(args: string[]): Promise<ExecResult> {
		const result = await this.exec("herdr", args, { timeout: HERDR_TIMEOUT_MS });
		if (result.code !== 0) parseResult(result, args.slice(0, 2).join(" "));
		return result;
	}

	private async run(args: string[]): Promise<any> {
		return parseResult(await this.execute(args), args.slice(0, 2).join(" "));
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private paneIds(): string[] {
		return [...this.surfaces.values()].flatMap((state) => state.paneId ? [state.paneId] : []);
	}

	private forgetPane(paneId: string): void {
		for (const [agentId, state] of this.surfaces) {
			if (state.paneId !== paneId) continue;
			state.paneId = undefined;
			this.surfaces.delete(agentId);
		}
	}

	private async paneExists(paneId: string): Promise<boolean> {
		try {
			await this.run(["pane", "get", paneId]);
			return true;
		} catch (error) {
			if (!isMissingPaneError(error)) throw error;
			this.forgetPane(paneId);
			return false;
		}
	}

	private async parentLayout(): Promise<HerdrPaneLayout> {
		const payload = await this.run(["pane", "layout", "--pane", this.parentPaneId]);
		const layout = payload?.result?.layout;
		if (!layout || typeof layout.tab_id !== "string" || !Array.isArray(layout.panes)) {
			throw new Error("Herdr pane layout did not return the parent tab geometry");
		}
		return layout;
	}

	private hasOnlyOwnedPanes(layout: HerdrPaneLayout): boolean {
		const allowed = new Set([this.parentPaneId, ...this.paneIds()]);
		return layout.panes.every((pane) => allowed.has(pane.pane_id));
	}

	private async splitTarget(candidateIds = new Set(this.paneIds())): Promise<{ paneId: string; direction: SplitDirection }> {
		const fallback = [...candidateIds][0];
		if (!fallback) throw new Error("No Herdr subagent pane is available to split");
		try {
			const payload = await this.run(["pane", "layout", "--pane", fallback]);
			const layoutPanes = Array.isArray(payload?.result?.layout?.panes) ? payload.result.layout.panes : [];
			const candidates = layoutPanes.filter((pane: any) => candidateIds.has(pane?.pane_id));
			const largest = candidates.reduce((best: any, pane: any) => {
				const area = Number(pane?.rect?.width ?? 0) * Number(pane?.rect?.height ?? 0);
				const bestArea = Number(best?.rect?.width ?? 0) * Number(best?.rect?.height ?? 0);
				return area > bestArea ? pane : best;
			}, candidates[0]);
			if (largest?.pane_id) {
				const width = Number(largest.rect?.width ?? 0);
				const height = Number(largest.rect?.height ?? 0);
				return { paneId: largest.pane_id, direction: width >= height * 2 ? "right" : "down" };
			}
		} catch { /* Layout only improves tiling; pane creation still has a safe fallback. */ }
		return { paneId: fallback, direction: "down" };
	}

	private startLayoutListener(): void {
		if (this.dedicatedTabId || this.unsubscribeLayouts || !this.subscribeLayouts || this.surfaces.size === 0) return;
		this.unsubscribeLayouts = this.subscribeLayouts((layout) => this.onLayout(layout));
	}

	private stopLayoutListener(): void {
		if (this.reflowTimer) clearTimeout(this.reflowTimer);
		this.reflowTimer = undefined;
		this.unsubscribeLayouts?.();
		this.unsubscribeLayouts = undefined;
	}

	private onLayout(layout: HerdrPaneLayout): void {
		if (this.dedicatedTabId || !this.parentTabId || layout.tab_id !== this.parentTabId || this.surfaces.size === 0) return;
		if (layout.zoomed || !this.hasOnlyOwnedPanes(layout)) return;
		const direction = responsiveSplitDirection(layout, this.currentDirection);
		if (direction === this.currentDirection) return;
		if (this.reflowTimer) clearTimeout(this.reflowTimer);
		this.reflowTimer = setTimeout(() => {
			this.reflowTimer = undefined;
			void this.serialize(() => this.reflow(direction)).catch(() => {
				// Keep child PTYs alive if responsive rearrangement is unavailable.
				// A later child lifecycle operation can still close each owned pane.
				this.stopLayoutListener();
			});
		}, REFLOW_DEBOUNCE_MS);
		this.reflowTimer.unref?.();
	}

	private updateMovedPane(state: HerdrSurfaceState, payload: any): { paneId: string; tabId?: string } {
		const move = payload?.result?.move_result ?? payload?.result;
		if (move?.changed === false) throw new Error(`Herdr pane move did not change the layout: ${move.reason ?? "unknown reason"}`);
		const paneId = move?.pane?.pane_id;
		if (typeof paneId !== "string" || !paneId) throw new Error("Herdr pane move did not return a pane ID");
		state.paneId = paneId;
		return { paneId, tabId: move?.pane?.tab_id ?? move?.created_tab?.tab_id };
	}

	private async moveToParent(
		state: HerdrSurfaceState,
		targetPaneId: string,
		direction: SplitDirection,
		ratio: number,
	): Promise<string> {
		const payload = await this.run([
			"pane", "move", state.paneId!, "--tab", this.parentTabId!,
			"--target-pane", targetPaneId, "--split", direction,
			"--ratio", String(ratio), "--no-focus",
		]);
		return this.updateMovedPane(state, payload).paneId;
	}

	private async restoreChildrenToParent(states: HerdrSurfaceState[], direction: SplitDirection): Promise<void> {
		const returned = new Set<string>();
		for (const state of states) {
			if (!state.paneId) continue;
			let pane: any;
			try { pane = (await this.run(["pane", "get", state.paneId]))?.result?.pane; }
			catch { continue; }
			if (pane?.tab_id === this.parentTabId) {
				returned.add(state.paneId);
				continue;
			}
			const target = returned.size === 0
				? { paneId: this.parentPaneId, direction, ratio: PRIMARY_PANE_RATIO }
				: { ...(await this.splitTarget(returned)), ratio: 0.5 };
			try {
				const paneId = await this.moveToParent(state, target.paneId, target.direction, target.ratio);
				returned.add(paneId);
			} catch { /* Preserve any pane that Herdr could not move back. */ }
		}
	}

	private async reflow(requestedDirection: SplitDirection): Promise<void> {
		if (this.dedicatedTabId || this.surfaces.size === 0 || requestedDirection === this.currentDirection) return;
		const layout = await this.parentLayout();
		if (layout.tab_id !== this.parentTabId || layout.zoomed || !this.hasOnlyOwnedPanes(layout)) return;
		const direction = responsiveSplitDirection(layout, this.currentDirection);
		if (direction === this.currentDirection) return;

		const states = [...this.surfaces.values()].filter((state) => state.paneId);
		if (states.length === 0) return;
		let stagingTabId: string | undefined;
		try {
			const first = states[0]!;
			const staged = this.updateMovedPane(first, await this.run([
				"pane", "move", first.paneId!, "--new-tab", "--workspace", this.workspaceId,
				"--label", REFLOW_TAB_LABEL, "--no-focus",
			]));
			stagingTabId = staged.tabId;
			if (!stagingTabId) throw new Error("Herdr pane move did not return the staging tab ID");
			let stagingTarget = staged.paneId;
			for (const state of states.slice(1)) {
				const moved = this.updateMovedPane(state, await this.run([
					"pane", "move", state.paneId!, "--tab", stagingTabId,
					"--target-pane", stagingTarget, "--split", "down", "--ratio", "0.5", "--no-focus",
				]));
				stagingTarget = moved.paneId;
			}

			const returned = new Set<string>();
			for (const [index, state] of states.entries()) {
				const target = index === 0
					? { paneId: this.parentPaneId, direction, ratio: PRIMARY_PANE_RATIO }
					: { ...(await this.splitTarget(returned)), ratio: 0.5 };
				const paneId = await this.moveToParent(state, target.paneId, target.direction, target.ratio);
				returned.add(paneId);
			}
			this.currentDirection = direction;
		} catch (error) {
			if (stagingTabId) await this.restoreChildrenToParent(states, direction);
			throw error;
		}
	}

	async ensurePane(state: HerdrSurfaceState, cwd: string): Promise<string> {
		return this.serialize(async () => {
			if (state.paneId && await this.paneExists(state.paneId)) return state.paneId;
			state.paneId = undefined;
			for (const paneId of this.paneIds()) await this.paneExists(paneId);

			let paneId: string;
			if (this.surfaces.size === 0) {
				const layout = await this.parentLayout();
				if (!layout.panes.some((pane) => pane.pane_id === this.parentPaneId)) {
					throw new Error("The parent Pi pane is not present in its Herdr tab");
				}
				this.parentTabId = layout.tab_id;
				if (this.hasOnlyOwnedPanes(layout)) {
					this.currentDirection = responsiveSplitDirection(layout);
					const payload = await this.run([
						"pane", "split", this.parentPaneId, "--direction", this.currentDirection,
						"--ratio", String(PRIMARY_PANE_RATIO), "--cwd", cwd, "--no-focus",
					]);
					paneId = payload?.result?.pane?.pane_id;
				} else {
					const payload = await this.run([
						"tab", "create", "--workspace", this.workspaceId,
						"--cwd", cwd, "--label", this.tabLabel(), "--no-focus",
					]);
					this.dedicatedTabId = payload?.result?.tab?.tab_id;
					paneId = payload?.result?.root_pane?.pane_id;
					if (!this.dedicatedTabId) throw new Error("Herdr tab create did not return a tab ID");
				}
			} else {
				const target = await this.splitTarget();
				const payload = await this.run([
					"pane", "split", target.paneId, "--direction", target.direction,
					"--ratio", "0.5", "--cwd", cwd, "--no-focus",
				]);
				paneId = payload?.result?.pane?.pane_id;
			}
			if (typeof paneId !== "string" || !paneId) throw new Error("Herdr pane split did not return a pane ID");
			state.paneId = paneId;
			this.surfaces.set(state.agentId, state);
			try {
				await this.run(["pane", "rename", paneId, state.name]);
				this.startLayoutListener();
			} catch (error) {
				this.surfaces.delete(state.agentId);
				state.paneId = undefined;
				try { await this.run(["pane", "close", paneId]); } catch { /* Preserve the rename failure. */ }
				if (this.surfaces.size === 0) {
					this.parentTabId = undefined;
					this.dedicatedTabId = undefined;
					this.currentDirection = undefined;
					this.stopLayoutListener();
				}
				throw error;
			}
			return paneId;
		});
	}

	async runCommand(paneId: string, command: string): Promise<void> {
		await this.execute(["pane", "run", paneId, command]);
	}

	async refreshTabLabel(): Promise<void> {
		await this.serialize(async () => {
			if (!this.dedicatedTabId) return;
			try { await this.run(["tab", "rename", this.dedicatedTabId, this.tabLabel()]); }
			catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/(?:unknown|missing|not found|does not exist).*tab|tab.*(?:unknown|missing|not found|does not exist)/i.test(message)) throw error;
				this.dedicatedTabId = undefined;
			}
		});
	}

	async interrupt(paneId: string): Promise<void> {
		try { await this.run(["pane", "send-keys", paneId, "ctrl+c"]); }
		catch { /* The pane may already be back at its shell. */ }
	}

	async waitUntilIdle(paneId: string, timeoutMs = STOP_TIMEOUT_MS): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		do {
			try {
				const payload = await this.run(["pane", "process-info", "--pane", paneId]);
				const processInfo = payload?.result?.process_info;
				const processes = processInfo?.foreground_processes;
				if (!Array.isArray(processes)) throw new Error("Herdr pane process-info omitted foreground processes");
				const shellPid = processInfo?.shell_pid;
				const foregroundWork = processes.filter((process: any) => process?.pid !== shellPid);
				if (foregroundWork.length === 0 || (foregroundWork.length === 1 && isInteractiveShell(foregroundWork[0]))) return true;
			} catch (error) {
				if (isMissingPaneError(error)) return true;
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		} while (Date.now() < deadline);
		return false;
	}

	async closePane(state: HerdrSurfaceState): Promise<void> {
		await this.serialize(async () => {
			const paneId = state.paneId;
			if (!paneId) return;
			state.paneId = undefined;
			this.surfaces.delete(state.agentId);
			try {
				await this.run(["pane", "close", paneId]);
			} catch (error) {
				if (!isMissingPaneError(error)) {
					state.paneId = paneId;
					this.surfaces.set(state.agentId, state);
					throw error;
				}
			}
			if (this.surfaces.size === 0) {
				this.parentTabId = undefined;
				this.dedicatedTabId = undefined;
				this.currentDirection = undefined;
				this.stopLayoutListener();
			}
		});
	}
}

interface PendingRequest {
	resolve: (response: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class HerdrAgentClient implements AgentClient {
	private server?: Server;
	private socket?: Socket;
	private readonly connections = new Set<Socket>();
	private readonly eventListeners = new Set<(event: RpcAgentEvent) => void>();
	private readonly exitListeners = new Set<(error: Error) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private nextRequestId = 0;
	private errorText = "";
	private stopping = false;
	private started = false;
	private ready?: Promise<void>;
	private resolveReady?: () => void;
	private rejectReady?: (error: Error) => void;
	private socketClosed?: Promise<void>;
	private resolveSocketClosed?: () => void;
	private bridgeDirectory?: string;
	private failed = false;

	constructor(
		private readonly options: HerdrAgentClientOptions,
		private readonly surfaces: HerdrSurfaceManager,
	) {}

	get pid(): undefined { return undefined; }
	getStderr(): string { return this.errorText; }

	onEvent(listener: (event: RpcAgentEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (error: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("Agent client already started");
		this.started = true;
		this.stopping = false;
		this.failed = false;
		try {
			const runtimeDirectory = process.env.XDG_RUNTIME_DIR || tmpdir();
			this.bridgeDirectory = await mkdtemp(join(runtimeDirectory, "pi-subagent-bridge-"));
			const socketPath = join(this.bridgeDirectory, "bridge.sock");
			const launcherPath = join(this.bridgeDirectory, "run-child");
			const token = randomBytes(32).toString("hex");
			await writeFile(launcherPath, launcherScript(this.options, socketPath, token), { mode: 0o700 });
			this.ready = new Promise<void>((resolve, reject) => {
				this.resolveReady = resolve;
				this.rejectReady = reject;
			});
			this.socketClosed = new Promise<void>((resolve) => { this.resolveSocketClosed = resolve; });
			this.server = net.createServer((socket) => this.accept(socket, token));
			await new Promise<void>((resolve, reject) => {
				this.server!.once("error", reject);
				this.server!.listen(socketPath, () => {
					this.server!.off("error", reject);
					resolve();
				});
			});
			this.server.on("error", (error) => this.fail(new Error(`Child bridge server failed: ${error.message}`)));
			const paneId = await this.surfaces.ensurePane(this.options.herdr, this.options.cwd);
			await this.surfaces.runCommand(paneId, shellQuote(launcherPath));
			await withTimeout(this.ready!, BRIDGE_START_TIMEOUT_MS, "Timed out waiting for the visible child bridge");
			await this.send({ type: "get_state" });
		} catch (error) {
			this.errorText = error instanceof Error ? error.message : String(error);
			await this.closeTransport();
			await this.surfaces.closePane(this.options.herdr);
			this.started = false;
			throw error;
		}
	}

	async prompt(message: string): Promise<void> { await this.send({ type: "prompt", message }); }
	async steer(message: string): Promise<void> { await this.send({ type: "steer", message }); }
	async abort(): Promise<void> { await this.send({ type: "abort" }); }

	async stop(): Promise<void> {
		if (!this.started) return;
		this.stopping = true;
		try {
			if (this.socket && !this.socket.destroyed) {
				try { await this.send({ type: "shutdown" }); }
				catch { /* Continue with pane-level shutdown below. */ }
			}
			if (this.socket && !this.socket.destroyed && this.socketClosed) {
				try { await withTimeout(this.socketClosed, STOP_TIMEOUT_MS, "Timed out waiting for the visible child to stop"); }
				catch { /* Fall through to terminal interruption below. */ }
			}
			const paneId = this.options.herdr.paneId;
			if (paneId && !await this.surfaces.waitUntilIdle(paneId)) {
				await this.surfaces.interrupt(paneId);
				if (!await this.surfaces.waitUntilIdle(paneId, 1_000)) {
					// Closing an extension-owned pane is the only reliable way to avoid an
					// orphan when a TUI ignores both graceful shutdown and Ctrl+C.
					await this.surfaces.closePane(this.options.herdr);
				}
			}
		} finally {
			await this.closeTransport();
			this.started = false;
		}
	}

	private accept(socket: Socket, expectedToken: string): void {
		if (this.socket && !this.socket.destroyed) {
			socket.destroy();
			return;
		}
		this.connections.add(socket);
		let authenticated = false;
		let buffer = "";
		const decoder = new StringDecoder("utf8");
		const onData = (chunk: Buffer | string) => {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			if (Buffer.byteLength(buffer) > MAX_RECORD_BYTES) {
				socket.destroy(new Error("Child bridge record exceeded the size limit"));
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message: any;
				try { message = JSON.parse(line); }
				catch { continue; }
				if (!authenticated) {
					if (message?.type !== "hello" || message.token !== expectedToken || message.agentId !== this.options.herdr.agentId) {
						socket.destroy(new Error("Rejected unauthenticated child bridge"));
						return;
					}
					if (this.socket && this.socket !== socket && !this.socket.destroyed) {
						socket.destroy();
						return;
					}
					authenticated = true;
					this.socket = socket;
					this.resolveReady?.();
					continue;
				}
				this.handleMessage(message);
			}
		};
		socket.setNoDelay(true);
		socket.on("data", onData);
		socket.once("error", (error) => {
			if (authenticated) this.fail(new Error(`Child bridge failed: ${error.message}`));
		});
		socket.once("close", () => {
			this.connections.delete(socket);
			if (!authenticated || this.socket !== socket) return;
			this.socket = undefined;
			this.resolveSocketClosed?.();
			if (!this.stopping) this.fail(new Error("Visible child bridge disconnected"));
		});
	}

	private handleMessage(message: any): void {
		if (!message || typeof message !== "object") return;
		if (message.type === "response" && typeof message.id === "string") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.success) pending.resolve(message);
			else pending.reject(new Error(message.error || `Child bridge command ${message.command ?? "unknown"} failed`));
			return;
		}
		for (const listener of [...this.eventListeners]) listener(message);
	}

	private send(command: Record<string, unknown>): Promise<any> {
		const socket = this.socket;
		if (!socket || socket.destroyed || !socket.writable) return Promise.reject(new Error("Visible child bridge is not connected"));
		const id = `subagent_${++this.nextRequestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for child bridge command ${command.type}`));
			}, BRIDGE_COMMAND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			socket.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				this.pending.delete(id);
				if (pending) clearTimeout(pending.timer);
				reject(error);
			});
		});
	}

	private fail(error: Error): void {
		if (this.failed) return;
		this.failed = true;
		if (!this.errorText) this.errorText = error.message;
		this.rejectReady?.(error);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		if (!this.stopping) for (const listener of [...this.exitListeners]) listener(error);
	}

	private async closeTransport(): Promise<void> {
		this.stopping = true;
		for (const connection of this.connections) connection.destroy();
		this.connections.clear();
		this.socket = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Agent client stopped"));
		}
		this.pending.clear();
		const server = this.server;
		this.server = undefined;
		if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		const bridgeDirectory = this.bridgeDirectory;
		this.bridgeDirectory = undefined;
		if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
	}
}

export function isHerdrParent(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_WORKSPACE_ID) && Boolean(env.HERDR_PANE_ID);
}
