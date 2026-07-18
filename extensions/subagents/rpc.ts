import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

const RPC_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 1_000;
const KILL_CLOSE_MS = 1_000;
const STDERR_LIMIT_BYTES = 16 * 1024;
const STDOUT_LINE_LIMIT_BYTES = 2 * 1024 * 1024;
const CHILD_ENV = "PI_SUBAGENT_CHILD";

export interface RpcAgentEvent {
	type: string;
	[key: string]: any;
}

export interface AgentClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	onEvent(listener: (event: RpcAgentEvent) => void): () => void;
	onExit(listener: (error: Error) => void): () => void;
	getStderr(): string;
	readonly pid?: number;
}

export interface AgentClientOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
}

export type AgentClientFactory = (options: AgentClientOptions) => AgentClient;

const liveChildPids = new Set<number>();
let exitReaperArmed = false;

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	if (process.platform === "win32") {
		const args = ["/PID", String(pid), "/T"];
		if (signal === "SIGKILL") args.push("/F");
		const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
		if (!result.error && result.status === 0) return;
	}
	try {
		if (process.platform !== "win32") process.kill(-pid, signal);
		else process.kill(pid, signal);
	} catch {
		try { process.kill(pid, signal); } catch { /* already stopped */ }
	}
}

function armExitReaper(): void {
	if (exitReaperArmed) return;
	exitReaperArmed = true;
	process.on("exit", () => {
		for (const pid of liveChildPids) killProcessGroup(pid, "SIGKILL");
		liveChildPids.clear();
	});
}

function boundedStderr(current: string, chunk: string): string {
	const combined = current + chunk;
	if (Buffer.byteLength(combined) <= STDERR_LIMIT_BYTES) return combined;
	const marker = "[earlier stderr omitted]\n";
	const available = Math.max(0, STDERR_LIMIT_BYTES - Buffer.byteLength(marker));
	let tail = combined.slice(-available);
	while (Buffer.byteLength(tail) > available) tail = tail.slice(1);
	return marker + tail;
}

function attachJsonlReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
	onError: (error: Error) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let failed = false;
	const failOversizedRecord = () => {
		if (failed) return;
		failed = true;
		buffer = "";
		onError(new Error(`Agent RPC record exceeded ${STDOUT_LINE_LIMIT_BYTES} bytes`));
	};
	const drain = () => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (Buffer.byteLength(line) > STDOUT_LINE_LIMIT_BYTES) {
				failOversizedRecord();
				return;
			}
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
			if (failed) return;
		}
	};
	const onData = (chunk: Buffer | string) => {
		if (failed) return;
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		drain();
		if (!failed && Buffer.byteLength(buffer) > STDOUT_LINE_LIMIT_BYTES) failOversizedRecord();
	};
	const onEnd = () => {
		if (failed) return;
		buffer += decoder.end();
		if (Buffer.byteLength(buffer) > STDOUT_LINE_LIMIT_BYTES) failOversizedRecord();
		else if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		buffer = "";
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function childEnvironment(agentId: string): Record<string, string> {
	return { [CHILD_ENV]: "1", PI_SUBAGENT_PARENT_ID: agentId };
}

export function isSubagentChild(): boolean {
	return process.env[CHILD_ENV] === "1";
}

interface PendingRequest {
	resolve: (response: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class RpcProcessClient implements AgentClient {
	private process?: ChildProcessWithoutNullStreams;
	private stopReading?: () => void;
	private readonly eventListeners = new Set<(event: RpcAgentEvent) => void>();
	private readonly exitListeners = new Set<(error: Error) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private nextRequestId = 0;
	private stderr = "";
	private exitError?: Error;
	private stopping = false;

	constructor(private readonly options: AgentClientOptions) {}

	get pid(): number | undefined { return this.process?.pid; }

	async start(): Promise<void> {
		if (this.process) throw new Error("Agent client already started");
		const child = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		this.process = child;
		if (child.pid) {
			liveChildPids.add(child.pid);
			armExitReaper();
		}
		child.stderr.on("data", (chunk) => {
			this.stderr = boundedStderr(this.stderr, chunk.toString());
		});
		child.stdin.on("error", (error) => this.fail(new Error(`Agent stdin failed: ${error.message}`)));
		child.once("error", (error) => this.fail(new Error(`Agent process failed: ${error.message}`)));
		child.once("close", (code, signal) => {
			if (child.pid) liveChildPids.delete(child.pid);
			const error = new Error(`Agent process exited (code=${code} signal=${signal})${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
			this.fail(error);
		});
		this.stopReading = attachJsonlReader(
			child.stdout,
			(line) => this.handleLine(line),
			(error) => {
				this.fail(error);
				void this.stop().catch(() => { /* exit reaper remains armed */ });
			},
		);
		try {
			await this.send({ type: "get_state" });
		} catch (error) {
			try { await this.stop(); } catch { /* preserve the startup error */ }
			throw error;
		}
	}

	onEvent(listener: (event: RpcAgentEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (error: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	getStderr(): string { return this.stderr; }

	async prompt(message: string): Promise<void> { await this.send({ type: "prompt", message }); }
	async steer(message: string): Promise<void> { await this.send({ type: "steer", message }); }
	async abort(): Promise<void> { await this.send({ type: "abort" }); }

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.stopping = true;
		this.stopReading?.();
		this.stopReading = undefined;
		let closed = child.exitCode !== null || child.signalCode !== null;
		if (!closed) {
			const gracefulClose = this.waitForClose(child, STOP_GRACE_MS);
			killProcessGroup(child.pid, "SIGTERM");
			closed = await gracefulClose;
		}
		if (!closed) {
			const forcedClose = this.waitForClose(child, KILL_CLOSE_MS);
			killProcessGroup(child.pid, "SIGKILL");
			closed = await forcedClose;
		}
		if (!closed) throw new Error(`Agent process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
		if (child.pid) liveChildPids.delete(child.pid);
		this.process = undefined;
		this.rejectPending(new Error("Agent client stopped"));
	}

	private waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (closed: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("close", onClose);
				resolve(closed);
			};
			const onClose = () => finish(true);
			const timer = setTimeout(() => finish(false), timeoutMs);
			child.once("close", onClose);
			if (child.exitCode !== null || child.signalCode !== null) finish(true);
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: any;
		try { message = JSON.parse(line); } catch { return; }
		if (!message || typeof message !== "object") return;
		if (message.type === "extension_ui_request") {
			this.cancelUiRequest(message);
			return;
		}
		if (message.type === "response" && message.id && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.success) pending.resolve(message);
			else pending.reject(new Error(message.error || `RPC command ${message.command ?? "unknown"} failed`));
			return;
		}
		for (const listener of [...this.eventListeners]) listener(message);
	}

	private cancelUiRequest(request: any): void {
		if (!request.id || !["select", "confirm", "input", "editor"].includes(request.method)) return;
		const response = request.method === "confirm"
			? { type: "extension_ui_response", id: request.id, confirmed: false }
			: { type: "extension_ui_response", id: request.id, cancelled: true };
		try { this.write(response); } catch { /* process exit handles failure */ }
	}

	private write(message: any): void {
		const child = this.process;
		if (!child || this.exitError) throw this.exitError ?? new Error("Agent client is not running");
		if (child.exitCode !== null || !child.stdin.writable || child.stdin.destroyed) {
			throw new Error(`Agent stdin is unavailable${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
		}
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private send(command: any): Promise<any> {
		if (this.exitError) return Promise.reject(this.exitError);
		const id = `subagent_${++this.nextRequestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${command.type}${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
			}, RPC_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try { this.write({ ...command, id }); }
			catch (error) {
				const pending = this.pending.get(id);
				this.pending.delete(id);
				if (pending) clearTimeout(pending.timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private fail(error: Error): void {
		if (this.exitError) return;
		this.exitError = error;
		this.stopReading?.();
		this.stopReading = undefined;
		this.rejectPending(error);
		if (!this.stopping) for (const listener of [...this.exitListeners]) listener(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
