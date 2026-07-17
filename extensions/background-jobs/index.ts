import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import { fitToolLine, highlightShellCommand } from "../better-native-pi/core.js";
import { BoundedOutput, CursorOutput, type CursorRead } from "./output.js";
import { clearBackgroundTerminalService, setBackgroundTerminalService, type BackgroundTerminalService } from "./service.js";
import { isPtySupported, spawnTerminal } from "./terminal-process.js";

export { BoundedOutput, CursorOutput } from "./output.js";

const ENTRY_TYPE = "background-job";
const NOTIFICATION_EVENT = "notification";
const STATUS_KEY = "background-jobs";
const MAX_CONCURRENT_JOBS = 16;
const MAX_RETAINED_JOBS = 50;
const TOOL_OUTPUT_BYTES = 24 * 1024;
const PARTIAL_OUTPUT_BYTES = 4 * 1024;
const PERSISTED_OUTPUT_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5_000;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_POLL_MS = 5 * 60 * 1_000;
const INTERACTION_REASONING_DESCRIPTION = "Short phrase stating the goal behind this terminal interaction, not the mechanics or command";

export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed" | "timed_out";

export interface JobSnapshot {
	id: string;
	description: string;
	command: string;
	cwd: string;
	status: JobStatus;
	tty?: boolean;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	stdout: string;
	stderr: string;
	stdoutOmittedBytes: number;
	stderrOmittedBytes: number;
	outputCursor?: number;
}

interface JobToolDetails extends JobSnapshot {
	managedTerminal: true;
	output?: string;
	cursor?: number;
	outputOmittedBytes?: number;
}

interface ManagedJob {
	id: string;
	description: string;
	command: string;
	cwd: string;
	status: JobStatus;
	tty: boolean;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	stdout: BoundedOutput;
	stderr: BoundedOutput;
	output: CursorOutput;
	agentCursor: number;
	process?: ChildProcess;
	ptyPid?: number;
	pendingClose?: { code: number | null; signal: NodeJS.Signals | null };
	timeout?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
	completion: Promise<void>;
	resolveCompletion: () => void;
	finalized: boolean;
	killReason?: "user" | "timeout" | "shutdown";
	suppressPersistence: boolean;
	sessionGeneration: number;
	activityListeners: Set<() => void>;
}

interface BackgroundJobsOptions {
	killGraceMs?: number;
}

function isActive(job: Pick<ManagedJob, "status">): boolean {
	return job.status === "running" || job.status === "stopping";
}

function compactDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function duration(job: Pick<JobSnapshot, "startedAt" | "endedAt">): number {
	return Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt);
}

function compactCommand(command: string, limit = 100): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function plainPreview(text: string, limit = 80): string {
	return compactCommand(text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""), limit);
}

function jobId(description: string, command: string, jobs: Map<string, ManagedJob>): string {
	const seed = (description || command.split(/\s+/, 1)[0] || "job")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 14) || "job";
	for (;;) {
		const id = `${seed}-${randomBytes(4).toString("hex")}`;
		if (!jobs.has(id)) return id;
	}
}

function statusSymbol(status: JobStatus): string {
	if (status === "running") return "●";
	if (status === "stopping") return "◌";
	if (status === "completed") return "✓";
	if (status === "timed_out") return "◷";
	if (status === "killed") return "■";
	return "×";
}

function statusColor(status: JobStatus): string {
	if (status === "running") return "accent";
	if (status === "stopping" || status === "timed_out") return "warning";
	if (status === "completed") return "success";
	if (status === "killed") return "muted";
	return "error";
}

function snapshot(job: ManagedJob, outputLimit?: number): JobSnapshot {
	return {
		id: job.id,
		description: job.description,
		command: job.command,
		cwd: job.cwd,
		status: job.status,
		tty: job.tty,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		signal: job.signal,
		stdout: job.stdout.text(outputLimit),
		stderr: job.stderr.text(outputLimit),
		stdoutOmittedBytes: job.stdout.omittedBytes,
		stderrOmittedBytes: job.stderr.omittedBytes,
		outputCursor: job.output.cursor,
	};
}

function restoredJob(data: JobSnapshot, generation: number): ManagedJob {
	let resolveCompletion!: () => void;
	const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
	const stdout = new BoundedOutput();
	const stderr = new BoundedOutput();
	const output = new CursorOutput();
	stdout.append(data.stdout ?? "");
	stderr.append(data.stderr ?? "");
	output.append(data.stdout ?? "");
	output.append(data.stderr ?? "");
	const job: ManagedJob = {
		...data,
		tty: Boolean(data.tty),
		stdout,
		stderr,
		output,
		agentCursor: output.cursor,
		completion,
		resolveCompletion,
		finalized: true,
		suppressPersistence: true,
		sessionGeneration: generation,
		activityListeners: new Set(),
	};
	resolveCompletion();
	return job;
}

function formatSnapshotText(data: JobSnapshot): string {
	const lines = [
		`${statusSymbol(data.status)} ${data.id} · ${data.status} · ${compactDuration(duration(data))}${data.tty ? " · tty" : ""}`,
		`cwd: ${data.cwd}`,
		`command: ${data.command}`,
	];
	if (data.exitCode !== undefined) lines.push(`exit code: ${data.exitCode}`);
	if (data.signal) lines.push(`signal: ${data.signal}`);
	if (data.stdout) lines.push("", data.tty ? "terminal output:" : "stdout:", data.stdout.trimEnd());
	if (data.stderr) lines.push("", "stderr:", data.stderr.trimEnd());
	if (!data.stdout && !data.stderr) lines.push("", "(no output)");
	return lines.join("\n");
}

function formatDeltaText(job: ManagedJob, read: CursorRead): string {
	const lines = [`${statusSymbol(job.status)} ${job.id} · ${job.status} · ${compactDuration(duration(job))}`];
	if (job.exitCode !== undefined) lines[0] += ` · exit ${job.exitCode}`;
	if (read.text) lines.push(read.text.trimEnd());
	else lines.push(isActive(job) ? "(no new output; terminal is still running)" : "(no new output)");
	return lines.join("\n");
}

class JobOutputViewer {
	private scroll = 0;
	private cachedWidth = 0;
	private cachedLines: string[] = [];
	private refreshTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly getSnapshot: () => JobSnapshot,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (result?: unknown) => void,
	) {
		if (getSnapshot().status === "running" || getSnapshot().status === "stopping") {
			this.refreshTimer = setInterval(() => {
				this.cachedWidth = 0;
				this.tui.requestRender();
				if (!(["running", "stopping"] as JobStatus[]).includes(this.getSnapshot().status)) this.stopRefreshing();
			}, 500);
			this.refreshTimer.unref?.();
		}
	}

	private stopRefreshing(): void {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private lines(width: number): string[] {
		if (this.cachedWidth === width) return this.cachedLines;
		const lines: string[] = [];
		for (const source of formatSnapshotText(this.getSnapshot()).split("\n")) {
			if (!source) { lines.push(""); continue; }
			lines.push(...wrapTextWithAnsi(source, Math.max(1, width)));
		}
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		const height = Math.max(10, (process.stdout.rows || 24) - 5);
		const bodyHeight = height - 1;
		if ((["running", "stopping"] as JobStatus[]).includes(this.getSnapshot().status)) this.cachedWidth = 0;
		const lines = this.lines(max);
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, max, "…"));
		while (visible.length < bodyHeight) visible.push("");
		return [...visible, truncateToWidth(this.theme.fg("dim", "↑↓/PgUp/PgDn · r refresh · q close"), max, "")];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.done(undefined);
		if (data === "r") this.cachedWidth = 0;
		else if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - 10);
		else if (matchesKey(data, Key.pageDown)) this.scroll += 10;
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
		this.tui.requestRender();
	}

	invalidate(): void { this.cachedWidth = 0; }
	dispose(): void { this.stopRefreshing(); }
}

function jobEntry(data: JobSnapshot, expanded: boolean, theme: any): Text {
	const color = statusColor(data.status);
	const header = `${theme.fg(color, statusSymbol(data.status))} ${theme.bold(data.description)} · ${data.id} · ${data.status} in ${compactDuration(duration(data))}${data.tty ? " · tty" : ""}`;
	const command = `  ${highlightShellCommand(compactCommand(data.command, 140), theme)}`;
	if (!expanded) return new Text(`${header}\n${command}`, 0, 0);
	return new Text(`${header}\n${command}\n${theme.fg("dim", formatSnapshotText(data))}`, 0, 0);
}

class TerminalInteractionComponent {
	constructor(
		private readonly details: JobToolDetails | undefined,
		private readonly args: any,
		private readonly expanded: boolean,
		private readonly theme: any,
		private readonly action: "read" | "write",
	) {}

	render(width: number): string[] {
		const max = Math.max(1, width);
		const details = this.details;
		if (!details) return [];
		const wrote = this.action === "write" && typeof this.args?.chars === "string" && this.args.chars.length > 0;
		const verb = this.action === "read" ? "Read from" : wrote ? "Interacted with" : "Waited for";
		const color = statusColor(details.status);
		const name = details.description || details.id;
		const reasoning = typeof this.args?.reasoning === "string" ? compactCommand(this.args.reasoning, 96) : "";
		const terminal = this.theme.fg("dim", compactCommand(name, 64));
		const goal = reasoning ? ` ${this.theme.fg("dim", "to")} ${this.theme.fg("accent", reasoning)}` : "";
		const elapsed = compactDuration(duration(details));
		const header = `${this.theme.fg(color, "•")} ${verb} ${terminal}${goal} ${this.theme.fg("dim", `· ${details.status} in ${elapsed}`)}`;
		const output = details.output?.replace(/\s+$/, "") || "(no new output)";
		const bodyWidth = Math.max(1, max - 4);
		let rows = output.split("\n").flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
		if (!this.expanded && rows.length > 5) {
			const omitted = rows.length - 4;
			rows = [...rows.slice(0, 2), `… +${omitted} lines (Ctrl+O)`, ...rows.slice(-2)];
		}
		return [
			fitToolLine(header, max),
			...rows.map((row) => truncateToWidth(`${this.theme.fg("dim", "  │ ")}${row}`, max, "…")),
			fitToolLine(`  └ ${this.theme.fg(color, statusSymbol(details.status))} ${this.theme.fg("dim", `${details.id}${details.tty ? " · tty" : ""}`)}`, max),
		];
	}

	invalidate(): void {}
}

class LiveJobComponent {
	private timer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly id: string,
		private fallback: JobSnapshot,
		private expanded: boolean,
		private readonly theme: any,
		private readonly getJob: (id: string) => ManagedJob | undefined,
		private readonly requestRender: () => void,
	) {
		this.syncTimer();
	}

	update(fallback: JobSnapshot, expanded: boolean): void {
		this.fallback = fallback;
		this.expanded = expanded;
		this.syncTimer();
	}

	private current(): JobSnapshot {
		const job = this.getJob(this.id);
		return job ? snapshot(job, TOOL_OUTPUT_BYTES) : this.fallback;
	}

	private syncTimer(): void {
		const current = this.current();
		if ((current.status === "running" || current.status === "stopping") && !this.timer) {
			this.timer = setInterval(() => this.requestRender(), 500);
			this.timer.unref?.();
		} else if (current.status !== "running" && current.status !== "stopping") {
			this.dispose();
		}
	}

	render(width: number): string[] {
		const current = this.current();
		if (current.status !== "running" && current.status !== "stopping") this.dispose();
		return jobEntry(current, this.expanded, this.theme).render(width);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

export default function registerBackgroundJobs(pi: ExtensionAPI, options: BackgroundJobsOptions = {}) {
	const jobs = new Map<string, ManagedJob>();
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	let activeCtx: any;
	let sessionGeneration = 0;

	const activeJobs = () => [...jobs.values()].filter(isActive);
	const updateStatus = () => {
		if (!activeCtx) return;
		const count = activeJobs().length;
		activeCtx.ui.setStatus(STATUS_KEY, count > 0 ? `${count} background job${count === 1 ? "" : "s"} running · /jobs to view` : undefined);
	};
	const emitActivity = (job: ManagedJob) => {
		for (const listener of [...job.activityListeners]) listener();
	};
	const appendOutput = (job: ManagedJob, stream: "stdout" | "stderr", chunk: Buffer) => {
		job[stream].append(chunk);
		job.output.append(chunk);
		emitActivity(job);
	};
	const trimRetained = () => {
		const completed = [...jobs.values()]
			.filter((job) => !isActive(job))
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		while (completed.length > MAX_RETAINED_JOBS) {
			const oldest = completed.shift();
			if (oldest) jobs.delete(oldest.id);
		}
	};
	const findJob = (idOrPrefix: string): ManagedJob | undefined => {
		if (jobs.has(idOrPrefix)) return jobs.get(idOrPrefix);
		const matches = [...jobs.values()].filter((job) => job.id.startsWith(idOrPrefix));
		return matches.length === 1 ? matches[0] : undefined;
	};
	const signalPid = (pid: number | undefined, signal: NodeJS.Signals): boolean => {
		if (!pid) return false;
		try {
			if (process.platform !== "win32") process.kill(-pid, signal);
			else process.kill(pid, signal);
			return true;
		} catch {
			try { process.kill(pid, signal); return true; } catch { return false; }
		}
	};
	const signalProcessTree = (job: ManagedJob, signal: NodeJS.Signals): boolean => {
		const ptySignaled = job.ptyPid && job.ptyPid !== job.process?.pid ? signalPid(job.ptyPid, signal) : false;
		const wrapperSignaled = signalPid(job.process?.pid, signal);
		return Boolean(ptySignaled || wrapperSignaled);
	};
	const pidExists = (pid: number | undefined): boolean => {
		if (!pid) return false;
		try { process.kill(pid, 0); return true; } catch { return false; }
	};
	let finalize!: (job: ManagedJob, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => void;
	const requestKill = (job: ManagedJob, reason: ManagedJob["killReason"]) => {
		if (!isActive(job) || job.killReason) return false;
		job.killReason = reason;
		job.status = "stopping";
		signalProcessTree(job, "SIGTERM");
		job.killTimer = setTimeout(() => {
			signalProcessTree(job, "SIGKILL");
			setTimeout(() => {
				if (job.pendingClose) finalize(job, job.pendingClose.code, job.pendingClose.signal);
			}, 25);
		}, killGraceMs);
		updateStatus();
		emitActivity(job);
		return true;
	};
	finalize = (job: ManagedJob, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
		if (job.finalized) return;
		job.finalized = true;
		job.endedAt = Date.now();
		job.exitCode = code ?? undefined;
		job.signal = signal ?? undefined;
		if (job.timeout) clearTimeout(job.timeout);
		if (job.killTimer) clearTimeout(job.killTimer);
		if (spawnError) {
			appendOutput(job, "stderr", Buffer.from(`${job.stderr.text() ? "\n" : ""}${spawnError.message}\n`));
			job.status = "failed";
		} else if (job.killReason === "timeout") job.status = "timed_out";
		else if (job.killReason) job.status = "killed";
		else job.status = code === 0 ? "completed" : "failed";
		emitActivity(job);
		job.resolveCompletion();
		trimRetained();
		updateStatus();

		if (!job.suppressPersistence && job.sessionGeneration === sessionGeneration) {
			pi.appendEntry(ENTRY_TYPE, snapshot(job, PERSISTED_OUTPUT_BYTES));
			const project = job.cwd.split("/").filter(Boolean).pop() || "pi";
			pi.events.emit(NOTIFICATION_EVENT, {
				title: `${project}: background job ${job.status}`,
				body: `${job.id}: ${compactCommand(job.command, 150)}`,
			});
			activeCtx?.ui.notify?.(`${job.id} ${job.status}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}.`, job.status === "completed" ? "info" : "warning");
		}
	};
	const startJob = (params: { command: string; description?: string; cwd?: string; timeoutSeconds?: number; tty?: boolean }, ctx: any): ManagedJob => {
		if (activeJobs().length >= MAX_CONCURRENT_JOBS) throw new Error(`At most ${MAX_CONCURRENT_JOBS} background jobs may run at once`);
		const command = params.command.trim();
		if (!command) throw new Error("Background command must not be empty");
		const timeoutSeconds = params.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
			throw new Error(`timeoutSeconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`);
		}
		if (params.tty && !isPtySupported()) throw new Error("PTY mode is unavailable on this platform");
		const cwd = resolve(ctx.cwd, params.cwd?.trim() || ".");
		try {
			if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
		} catch {
			throw new Error(`Working directory does not exist or is not a directory: ${cwd}`);
		}
		const description = compactCommand(params.description?.trim() || command, 80);
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
		const job: ManagedJob = {
			id: jobId(description, command, jobs),
			description,
			command,
			cwd,
			status: "running",
			tty: Boolean(params.tty),
			startedAt: Date.now(),
			stdout: new BoundedOutput(),
			stderr: new BoundedOutput(),
			output: new CursorOutput(),
			agentCursor: 0,
			completion,
			resolveCompletion,
			finalized: false,
			suppressPersistence: false,
			sessionGeneration,
			activityListeners: new Set(),
		};
		jobs.set(job.id, job);
		try {
			job.process = spawnTerminal({
				command,
				cwd,
				tty: job.tty,
				onStdout: (chunk) => appendOutput(job, "stdout", chunk),
				onStderr: (chunk) => appendOutput(job, "stderr", chunk),
				onPtyPid: (pid) => { job.ptyPid = pid; },
			});
		} catch (error) {
			jobs.delete(job.id);
			throw error;
		}
		job.process.stdin?.on("error", () => {});
		job.process.once("error", (error) => finalize(job, null, null, error));
		job.process.once("close", (code, signal) => {
			if (job.ptyPid && pidExists(job.ptyPid)) {
				job.pendingClose = { code, signal };
				if (!job.killReason) {
					job.killReason = "shutdown";
					job.status = "stopping";
					signalPid(job.ptyPid, "SIGKILL");
					setTimeout(() => finalize(job, code, signal), 25);
				}
				return;
			}
			finalize(job, code, signal);
		});
		if (timeoutSeconds !== undefined) {
			job.timeout = setTimeout(() => requestKill(job, "timeout"), timeoutSeconds * 1000);
			job.timeout.unref?.();
		}
		updateStatus();
		return job;
	};
	const waitForCompletion = async (job: ManagedJob, signal?: AbortSignal) => {
		if (!isActive(job)) return;
		if (!signal) return job.completion;
		await new Promise<void>((resolvePromise) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", finish);
				resolvePromise();
			};
			job.completion.then(finish);
			if (signal.aborted) finish();
			else signal.addEventListener("abort", finish, { once: true });
		});
	};
	const waitForActivity = async (job: ManagedJob, cursor: number, waitMs: number, signal?: AbortSignal) => {
		if (!isActive(job) || waitMs <= 0 || signal?.aborted) return;
		await new Promise<void>((resolvePromise) => {
			let settled = false;
			let deadline: ReturnType<typeof setTimeout> | undefined;
			let quietTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (deadline) clearTimeout(deadline);
				if (quietTimer) clearTimeout(quietTimer);
				job.activityListeners.delete(onActivity);
				signal?.removeEventListener("abort", finish);
				resolvePromise();
			};
			const onActivity = () => {
				if (!isActive(job)) { finish(); return; }
				if (job.output.cursor <= cursor) return;
				if (quietTimer) clearTimeout(quietTimer);
				// PTYs commonly echo input immediately and emit the program response in
				// the next chunk. A short quiet window returns both as one interaction.
				quietTimer = setTimeout(finish, 25);
			};
			job.activityListeners.add(onActivity);
			deadline = setTimeout(finish, waitMs);
			if (signal) signal.addEventListener("abort", finish, { once: true });
			onActivity();
		});
	};
	const waitForYield = async (job: ManagedJob, yieldMs: number, signal?: AbortSignal) => {
		if (!isActive(job)) return;
		await new Promise<void>((resolvePromise) => {
			let settled = false;
			const timer = setTimeout(finish, yieldMs);
			function finish() {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				resolvePromise();
			}
			job.completion.then(finish);
			if (signal?.aborted) finish();
			else signal?.addEventListener("abort", finish, { once: true });
		});
	};
	const readDelta = (job: ManagedJob, cursor: number, advanceAgentCursor: boolean): { read: CursorRead; details: JobToolDetails } => {
		const read = job.output.read(cursor, TOOL_OUTPUT_BYTES);
		if (advanceAgentCursor) job.agentCursor = read.cursor;
		return {
			read,
			details: {
				managedTerminal: true,
				...snapshot(job, PERSISTED_OUTPUT_BYTES),
				output: read.text,
				cursor: read.cursor,
				outputOmittedBytes: read.omittedBytes,
			},
		};
	};
	const writeInput = async (job: ManagedJob, chars: string, closeStdin: boolean) => {
		if (!isActive(job)) return;
		const stdin = job.process?.stdin;
		if (!stdin || stdin.destroyed) throw new Error(`Terminal ${job.id} does not accept input`);
		if (chars) {
			await new Promise<void>((resolvePromise, reject) => {
				stdin.write(chars, (error) => error ? reject(error) : resolvePromise());
			});
		}
		if (closeStdin) stdin.end();
	};
	const showOutput = async (job: ManagedJob, ctx: any) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(formatSnapshotText(snapshot(job, TOOL_OUTPUT_BYTES)), "info");
			return;
		}
		await ctx.ui.custom((tui: TUI, theme: any, _kb: any, done: (result: unknown) => void) =>
			new JobOutputViewer(() => snapshot(job), tui, theme, done), {
				overlay: true,
				overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 },
			});
	};
	const confirmKill = async (job: ManagedJob, ctx: any): Promise<boolean> => {
		if (!isActive(job) || job.killReason) return false;
		if (!ctx.hasUI && ctx.mode !== "tui") return false;
		return ctx.ui.confirm("Stop background job?", `${job.id}\n${job.command}\n\nThis sends SIGTERM to the process tree, then SIGKILL after ${killGraceMs / 1000}s if needed.`);
	};
	const liveResult = (result: any, options: any, theme: any, context: any) => {
		const data = result.details as JobSnapshot | undefined;
		if (!data?.id) return new Text(result?.content?.[0]?.text ?? "", 0, 0);
		let component = context.state.liveJob as LiveJobComponent | undefined;
		if (!component) {
			component = new LiveJobComponent(data.id, data, Boolean(options.expanded), theme, (id) => jobs.get(id), context.invalidate);
			context.state.liveJob = component;
		} else component.update(data, Boolean(options.expanded));
		return component;
	};
	const executeUnified = async (_id: string, rawParams: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => {
		const params = {
			...rawParams,
			description: rawParams.description ?? rawParams.reasoning,
			timeoutSeconds: rawParams.timeoutSeconds ?? rawParams.timeout,
		};
		const yieldMs = params["yield-time_ms"] ?? DEFAULT_YIELD_MS;
		if (!Number.isInteger(yieldMs) || yieldMs < 250 || yieldMs > 30_000) throw new Error("yield-time_ms must be an integer between 250 and 30000");
		const job = startJob(params, ctx);
		const initialCursor = 0;
		let lastUpdate = 0;
		const update = () => {
			const now = Date.now();
			if (!onUpdate || now - lastUpdate < 100) return;
			lastUpdate = now;
			const partial = job.output.read(initialCursor, PARTIAL_OUTPUT_BYTES);
			onUpdate({
				content: [{ type: "text", text: formatDeltaText(job, partial) }],
				details: { managedTerminal: true, ...snapshot(job, PERSISTED_OUTPUT_BYTES) },
			});
		};
		job.activityListeners.add(update);
		try { await waitForYield(job, yieldMs, signal); } finally { job.activityListeners.delete(update); }
		const { read, details } = readDelta(job, initialCursor, true);
		const prefix = isActive(job) ? `Terminal ${job.id} is still running. Use terminal_write or job_output with job_id=${job.id}.\n` : "";
		return { content: [{ type: "text", text: `${prefix}${formatDeltaText(job, read)}` }], details };
	};
	const terminalService: BackgroundTerminalService = {
		execute: executeUnified,
		getView: (id, fallback, maxOutputBytes) => {
			const job = jobs.get(id);
			if (job) {
				return {
					details: { managedTerminal: true, ...snapshot(job, PERSISTED_OUTPUT_BYTES) },
					output: job.output.read(0, maxOutputBytes).text,
				};
			}
			const details = fallback ?? {};
			return {
				details,
				output: details.output ?? [details.stdout, details.stderr].filter(Boolean).join("\n"),
			};
		},
		renderResult: liveResult,
	};
	setBackgroundTerminalService(terminalService);

	// Completion entries persist final state but intentionally render nothing:
	// the original tool card reads the live/restored job and updates in place.
	pi.registerEntryRenderer<JobSnapshot>(ENTRY_TYPE, () => new Container());

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: "Run a shell command. Quick commands return normally; long-running commands yield a managed terminal ID. Set tty=true for prompts, REPLs, and control characters, then use terminal_write to interact.",
		promptSnippet: "Run shell commands with automatic background yielding and optional PTY interaction",
		promptGuidelines: [
			"Use bash for shell commands. Quick commands return normally; long-running commands automatically yield a terminal ID.",
			"Set bash tty=true for interactive prompts, REPLs, watch processes, or when terminal_write may need to send control characters such as Ctrl+C.",
		],
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run" },
				timeout: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `Optional hard timeout from 1 to ${MAX_TIMEOUT_SECONDS} seconds` },
				cwd: { type: "string", description: "Working directory, relative to the current project unless absolute" },
				tty: { type: "boolean", description: "Allocate a PTY for prompts, REPLs, and control characters", default: false },
				"yield-time_ms": { type: "integer", minimum: 250, maximum: 30_000, description: `Wait before yielding a terminal ID (default ${DEFAULT_YIELD_MS} ms)` },
				reasoning: { type: "string", description: "Goal or intent behind running this command" },
			},
			required: ["command", "reasoning"],
		} as any,
		executionMode: "sequential",
		execute: executeUnified,
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("accent", "●")} ${theme.bold("Running bash")} ${args.reasoning || highlightShellCommand(compactCommand(args.command || ""), theme)}`, 0, 0),
		renderResult: liveResult,
		renderShell: "self",
	});

	pi.registerTool({
		name: "terminal_exec",
		label: "Terminal Exec",
		description: "Run a shell command, returning normally if it finishes within the yield window or a managed terminal ID if it keeps running. Supports optional PTY interaction through terminal_write.",
		promptSnippet: "Run shell commands that may be quick, long-running, or interactive",
		promptGuidelines: ["Use terminal_exec when command duration is uncertain, when a process may stay running, or when terminal interaction may be needed. Quick commands return normally; long commands yield a terminal ID."],
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run" },
				description: { type: "string", description: "Short human-readable terminal name" },
				cwd: { type: "string", description: "Working directory, relative to the current project unless absolute" },
				tty: { type: "boolean", description: "Allocate a PTY for prompts, REPLs, and control characters", default: false },
				"yield-time_ms": { type: "integer", minimum: 250, maximum: 30_000, description: `Wait before yielding a terminal ID (default ${DEFAULT_YIELD_MS} ms)` },
				timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `Optional hard timeout from 1 to ${MAX_TIMEOUT_SECONDS} seconds` },
				reasoning: { type: "string", description: "Goal or intent behind running this command" },
			},
			required: ["command", "reasoning"],
		} as any,
		executionMode: "sequential",
		execute: executeUnified,
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("accent", "●")} ${theme.bold("Running terminal")} ${args.reasoning || highlightShellCommand(compactCommand(args.command || ""), theme)}`, 0, 0),
		renderResult: liveResult,
		renderShell: "self",
	});

	pi.registerTool({
		name: "background_bash",
		label: "Background Bash",
		description: "Compatibility alias that starts an explicit shell command immediately in a managed background terminal. Prefer terminal_exec for new calls.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run" },
				description: { type: "string", description: "Short human-readable job name" },
				cwd: { type: "string", description: "Working directory, relative to the current project unless absolute" },
				tty: { type: "boolean", description: "Allocate a PTY for interactive input", default: false },
				timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `Optional timeout from 1 to ${MAX_TIMEOUT_SECONDS} seconds` },
				reasoning: { type: "string", description: "Goal or intent behind starting this background job" },
			},
			required: ["command", "reasoning"],
		} as any,
		promptGuidelines: ["Use background_bash only when immediate backgrounding is explicitly desired; otherwise prefer terminal_exec."],
		executionMode: "sequential",
		async execute(_id: string, params: any, _signal: AbortSignal, _update: any, ctx: any) {
			const job = startJob(params, ctx);
			return {
				content: [{ type: "text", text: `Background terminal ${job.id} started in ${job.cwd}. Use terminal_write or job_output to inspect it.` }],
				details: { managedTerminal: true, ...snapshot(job, PERSISTED_OUTPUT_BYTES) },
			};
		},
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("accent", "●")} ${theme.bold("Starting background terminal")} ${args.reasoning || highlightShellCommand(compactCommand(args.command || ""), theme)}`, 0, 0),
		renderResult: liveResult,
		renderShell: "self",
	});

	pi.registerTool({
		name: "job_output",
		label: "Job Output",
		description: "Read only new bounded output from a managed terminal. Returns a cursor and can wait for new output or completion.",
		parameters: {
			type: "object",
			properties: {
				reasoning: { type: "string", description: INTERACTION_REASONING_DESCRIPTION },
				job_id: { type: "string", description: "Full terminal ID or an unambiguous prefix" },
				cursor: { type: "integer", minimum: 0, description: "Optional output cursor; defaults to this tool's last read position" },
				waitMs: { type: "integer", minimum: 0, maximum: MAX_POLL_MS, description: "Wait this many milliseconds for new output" },
				wait: { type: "boolean", description: "Compatibility option: wait until the terminal finishes", default: false },
			},
			required: ["reasoning", "job_id"],
		} as any,
		promptGuidelines: ["Always pass a reasoning phrase to job_output that states why the new terminal output matters."],
		executionMode: "sequential",
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const job = findJob(params.job_id);
			if (!job) throw new Error(`Background terminal not found or prefix is ambiguous: ${params.job_id}`);
			const explicitCursor = params.cursor !== undefined;
			const cursor = explicitCursor ? params.cursor : job.agentCursor;
			if (!Number.isInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
			const waitMs = params.waitMs ?? 0;
			if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_POLL_MS) throw new Error(`waitMs must be an integer between 0 and ${MAX_POLL_MS}`);
			if (params.wait) await waitForCompletion(job, signal);
			else await waitForActivity(job, cursor, waitMs, signal);
			const { read, details } = readDelta(job, cursor, !explicitCursor);
			return { content: [{ type: "text", text: formatDeltaText(job, read) }], details };
		},
		renderCall: () => new Container(),
		renderResult: (result: any, options: any, theme: any, context: any) =>
			new TerminalInteractionComponent(result.details as JobToolDetails | undefined, context.args, Boolean(options.expanded), theme, "read"),
		renderShell: "self",
	});

	pi.registerTool({
		name: "terminal_write",
		label: "Terminal Write",
		description: "Write characters to a managed terminal, or poll with empty input. Supports PTY control characters such as \\u0003 for Ctrl+C.",
		parameters: {
			type: "object",
			properties: {
				reasoning: { type: "string", description: INTERACTION_REASONING_DESCRIPTION },
				job_id: { type: "string", description: "Full terminal ID or an unambiguous prefix" },
				chars: { type: "string", description: "Characters to write; empty polls without writing", default: "" },
				"yield-time_ms": { type: "integer", minimum: 0, maximum: MAX_POLL_MS, description: `Wait for output after writing (default ${DEFAULT_POLL_MS} ms)` },
				close_stdin: { type: "boolean", description: "Close stdin after writing", default: false },
			},
			required: ["reasoning", "job_id"],
		} as any,
		promptGuidelines: ["Always pass a reasoning phrase to terminal_write that states the goal of waiting or interacting."],
		executionMode: "sequential",
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const job = findJob(params.job_id);
			if (!job) throw new Error(`Background terminal not found or prefix is ambiguous: ${params.job_id}`);
			const chars = typeof params.chars === "string" ? params.chars : "";
			const yieldMs = params["yield-time_ms"] ?? DEFAULT_POLL_MS;
			if (!Number.isInteger(yieldMs) || yieldMs < 0 || yieldMs > MAX_POLL_MS) throw new Error(`yield-time_ms must be an integer between 0 and ${MAX_POLL_MS}`);
			const cursor = job.agentCursor;
			if (chars || params.close_stdin) await writeInput(job, chars, Boolean(params.close_stdin));
			await waitForActivity(job, cursor, yieldMs, signal);
			const { read, details } = readDelta(job, cursor, true);
			return { content: [{ type: "text", text: formatDeltaText(job, read) }], details };
		},
		renderCall: () => new Container(),
		renderResult: (result: any, options: any, theme: any, context: any) =>
			new TerminalInteractionComponent(result.details as JobToolDetails | undefined, context.args, Boolean(options.expanded), theme, "write"),
		renderShell: "self",
	});

	pi.registerTool({
		name: "job_kill",
		label: "Stop Job",
		description: "Stop one managed terminal after explicit user confirmation.",
		parameters: {
			type: "object",
			properties: { job_id: { type: "string", description: "Full terminal ID or an unambiguous prefix" } },
			required: ["job_id"],
		} as any,
		executionMode: "sequential",
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: any) {
			const job = findJob(params.job_id);
			if (!job) throw new Error(`Background terminal not found or prefix is ambiguous: ${params.job_id}`);
			if (!isActive(job)) return { content: [{ type: "text", text: `${job.id} is already ${job.status}.` }], details: snapshot(job, PERSISTED_OUTPUT_BYTES) };
			if (job.killReason) return { content: [{ type: "text", text: `Stop already requested for background terminal ${job.id}.` }], details: snapshot(job, PERSISTED_OUTPUT_BYTES) };
			if (!(await confirmKill(job, ctx))) throw new Error(`Did not stop ${job.id}; user confirmation was not granted.`);
			requestKill(job, "user");
			return { content: [{ type: "text", text: `Sent SIGTERM to background terminal ${job.id}.` }], details: snapshot(job, PERSISTED_OUTPUT_BYTES) };
		},
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("warning", "■")} Requesting stop for ${args.job_id ?? "terminal"}`, 0, 0),
		renderResult: (result: any, _options: any, theme: any, context: any) => new Text(context?.isError ? theme.fg("warning", result?.content?.[0]?.text ?? "") : result?.content?.[0]?.text ?? "", 0, 0),
		renderShell: "self",
	});

	const handleJobsCommand = async (args: string, ctx: any) => {
		const [action, id] = args.trim().split(/\s+/, 2);
		if (action === "output" && id) {
			const job = findJob(id);
			if (!job) { ctx.ui.notify(`Terminal not found or prefix ambiguous: ${id}`, "warning"); return; }
			await showOutput(job, ctx);
			return;
		}
		if ((action === "stop" || action === "kill") && id === "all") {
			const active = activeJobs().filter((job) => !job.killReason);
			if (active.length === 0) { ctx.ui.notify("No running background terminals.", "info"); return; }
			if (!ctx.hasUI || !(await ctx.ui.confirm("Stop all background terminals?", `${active.length} terminal${active.length === 1 ? "" : "s"} will receive SIGTERM, then SIGKILL if needed.`))) return;
			for (const job of active) requestKill(job, "user");
			ctx.ui.notify(`Stopping ${active.length} background terminal${active.length === 1 ? "" : "s"}.`, "info");
			return;
		}
		if ((action === "kill" || action === "stop") && id) {
			const job = findJob(id);
			if (!job) { ctx.ui.notify(`Terminal not found or prefix ambiguous: ${id}`, "warning"); return; }
			if (!isActive(job)) { ctx.ui.notify(`${job.id} is already ${job.status}.`, "info"); return; }
			if (job.killReason) { ctx.ui.notify(`Stop already requested for ${job.id}.`, "info"); return; }
			if (await confirmKill(job, ctx)) requestKill(job, "user");
			return;
		}
		if (action && action !== "list") {
			ctx.ui.notify("Usage: /jobs [list|output <id>|stop <id>|stop all]", "warning");
			return;
		}
		const ordered = [...jobs.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt);
		if (ordered.length === 0) { ctx.ui.notify("No background terminals in this session.", "info"); return; }
		const labels = ordered.map((job) => {
			const latest = plainPreview(job.output.latestLine(), 64);
			return `${statusSymbol(job.status)} ${job.description} · ${job.id} · ${job.status} · ${compactDuration(duration(job))}${latest ? ` · ↳ ${latest}` : ""}`;
		});
		const selected = await ctx.ui.select(`Background terminals (${activeJobs().length} running)`, labels);
		if (!selected) return;
		const job = ordered[labels.indexOf(selected)];
		if (!job) return;
		const choices = isActive(job) ? ["View full output", "Stop terminal", "Cancel"] : ["View full output", "Cancel"];
		const choice = await ctx.ui.select(`${job.id}\n${job.command}`, choices);
		if (choice === "View full output") await showOutput(job, ctx);
		else if (choice === "Stop terminal" && !job.killReason && await confirmKill(job, ctx)) requestKill(job, "user");
	};

	pi.registerCommand("jobs", {
		description: "List, inspect, or stop managed background terminals",
		handler: handleJobsCommand,
	});
	pi.registerCommand("ps", {
		description: "Alias for /jobs: list managed background terminals",
		handler: handleJobsCommand,
	});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration += 1;
		activeCtx = ctx;
		const activeTools = pi.getActiveTools();
		const aliases = new Set(["terminal_exec", "background_bash"]);
		const normalizedTools = activeTools.filter((name) => !aliases.has(name));
		if (normalizedTools.length !== activeTools.length && !normalizedTools.includes("bash")) normalizedTools.push("bash");
		if (normalizedTools.length !== activeTools.length || normalizedTools.some((name, index) => name !== activeTools[index])) pi.setActiveTools(normalizedTools);
		jobs.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			const data = entry.data as JobSnapshot;
			if (data.status === "running" || data.status === "stopping") continue;
			jobs.set(data.id, restoredJob(data, sessionGeneration));
		}
		trimRetained();
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		sessionGeneration += 1;
		const stopping = activeJobs();
		for (const job of stopping) {
			job.suppressPersistence = true;
			requestKill(job, "shutdown");
		}
		await Promise.all(stopping.map((job) => job.completion));
		activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		jobs.clear();
		clearBackgroundTerminalService(terminalService);
		activeCtx = undefined;
	});
}
