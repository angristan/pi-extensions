import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import { highlightShellCommand } from "../better-native-pi/core.js";

const ENTRY_TYPE = "background-job";
const NOTIFICATION_EVENT = "notification";
const MAX_CONCURRENT_JOBS = 16;
const MAX_RETAINED_JOBS = 50;
const OUTPUT_HEAD_BYTES = 16 * 1024;
const OUTPUT_TAIL_BYTES = 240 * 1024;
const TOOL_OUTPUT_BYTES = 24 * 1024;
const PERSISTED_OUTPUT_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5_000;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

type JobStatus = "running" | "completed" | "failed" | "killed" | "timed_out";

export interface JobSnapshot {
	id: string;
	description: string;
	command: string;
	cwd: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	stdout: string;
	stderr: string;
	stdoutOmittedBytes: number;
	stderrOmittedBytes: number;
}

export class BoundedOutput {
	private head = Buffer.alloc(0);
	private tail = Buffer.alloc(0);
	private totalBytes = 0;

	append(chunk: Buffer | string): void {
		let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.totalBytes += bytes.length;
		if (this.head.length < OUTPUT_HEAD_BYTES) {
			const take = Math.min(OUTPUT_HEAD_BYTES - this.head.length, bytes.length);
			this.head = Buffer.concat([this.head, bytes.subarray(0, take)]);
			bytes = bytes.subarray(take);
		}
		if (bytes.length > 0) {
			this.tail = Buffer.concat([this.tail, bytes]);
			if (this.tail.length > OUTPUT_TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - OUTPUT_TAIL_BYTES);
		}
	}

	get omittedBytes(): number {
		return Math.max(0, this.totalBytes - this.head.length - this.tail.length);
	}

	text(limitBytes?: number): string {
		if (limitBytes !== undefined) {
			if (this.totalBytes === 0) return "";
			const tail = this.tail.length > 0 ? this.tail : this.head;
			const bounded = tail.length > limitBytes ? tail.subarray(tail.length - limitBytes) : tail;
			const omitted = Math.max(0, this.totalBytes - bounded.length);
			return `${omitted > 0 ? `[... ${omitted.toLocaleString()} earlier bytes omitted ...]\n` : ""}${bounded.toString("utf8")}`;
		}
		const marker = this.omittedBytes > 0 ? `\n[... ${this.omittedBytes.toLocaleString()} bytes omitted ...]\n` : "";
		return `${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`;
	}
}

interface ManagedJob {
	id: string;
	description: string;
	command: string;
	cwd: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	stdout: BoundedOutput;
	stderr: BoundedOutput;
	process?: ChildProcess;
	timeout?: ReturnType<typeof setTimeout>;
	killTimer?: ReturnType<typeof setTimeout>;
	completion: Promise<void>;
	resolveCompletion: () => void;
	finalized: boolean;
	killReason?: "user" | "timeout" | "shutdown";
	suppressPersistence: boolean;
	sessionGeneration: number;
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

function jobId(description: string, command: string): string {
	const seed = (description || command.split(/\s+/, 1)[0] || "job")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 14) || "job";
	return `${seed}-${randomBytes(2).toString("hex")}`;
}

function statusSymbol(status: JobStatus): string {
	if (status === "running") return "●";
	if (status === "completed") return "✓";
	if (status === "timed_out") return "◷";
	if (status === "killed") return "■";
	return "×";
}

function statusColor(status: JobStatus): string {
	if (status === "running") return "accent";
	if (status === "completed") return "success";
	if (status === "timed_out") return "warning";
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
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		signal: job.signal,
		stdout: job.stdout.text(outputLimit),
		stderr: job.stderr.text(outputLimit),
		stdoutOmittedBytes: job.stdout.omittedBytes,
		stderrOmittedBytes: job.stderr.omittedBytes,
	};
}

function restoredJob(data: JobSnapshot, generation: number): ManagedJob {
	let resolveCompletion!: () => void;
	const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
	const stdout = new BoundedOutput();
	const stderr = new BoundedOutput();
	stdout.append(data.stdout);
	stderr.append(data.stderr);
	const job: ManagedJob = {
		...data,
		stdout,
		stderr,
		completion,
		resolveCompletion,
		finalized: true,
		suppressPersistence: true,
		sessionGeneration: generation,
	};
	resolveCompletion();
	return job;
}

function formatSnapshotText(data: JobSnapshot): string {
	const lines = [
		`${statusSymbol(data.status)} ${data.id} · ${data.status} · ${compactDuration(duration(data))}`,
		`cwd: ${data.cwd}`,
		`command: ${data.command}`,
	];
	if (data.exitCode !== undefined) lines.push(`exit code: ${data.exitCode}`);
	if (data.signal) lines.push(`signal: ${data.signal}`);
	if (data.stdout) lines.push("", "stdout:", data.stdout.trimEnd());
	if (data.stderr) lines.push("", "stderr:", data.stderr.trimEnd());
	if (!data.stdout && !data.stderr) lines.push("", "(no output)");
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
		if (getSnapshot().status === "running") {
			this.refreshTimer = setInterval(() => {
				this.cachedWidth = 0;
				this.tui.requestRender();
				if (this.getSnapshot().status !== "running") this.stopRefreshing();
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
		const data = this.getSnapshot();
		const lines: string[] = [];
		for (const source of formatSnapshotText(data).split("\n")) {
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
		if (this.getSnapshot().status === "running") this.cachedWidth = 0;
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
	const header = `${theme.fg(color, statusSymbol(data.status))} ${theme.bold(data.description)} · ${data.id} · ${data.status} in ${compactDuration(duration(data))}`;
	const command = `  ${highlightShellCommand(compactCommand(data.command, 140), theme)}`;
	if (!expanded) return new Text(`${header}\n${command}`, 0, 0);
	return new Text(`${header}\n${command}\n${theme.fg("dim", formatSnapshotText(data))}`, 0, 0);
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, ManagedJob>();
	let activeCtx: any;
	let sessionGeneration = 0;

	const runningJobs = () => [...jobs.values()].filter((job) => job.status === "running");
	const trimRetained = () => {
		const completed = [...jobs.values()]
			.filter((job) => job.status !== "running")
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
	const signalProcessGroup = (job: ManagedJob, signal: NodeJS.Signals): boolean => {
		const child = job.process;
		if (!child?.pid) return false;
		try {
			if (process.platform !== "win32") process.kill(-child.pid, signal);
			else child.kill(signal);
			return true;
		} catch {
			try { return child.kill(signal); } catch { return false; }
		}
	};
	const requestKill = (job: ManagedJob, reason: ManagedJob["killReason"]) => {
		if (job.status !== "running") return false;
		job.killReason = reason;
		signalProcessGroup(job, "SIGTERM");
		job.killTimer = setTimeout(() => signalProcessGroup(job, "SIGKILL"), KILL_GRACE_MS);
		job.killTimer.unref?.();
		return true;
	};
	const finalize = (job: ManagedJob, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
		if (job.finalized) return;
		job.finalized = true;
		job.endedAt = Date.now();
		job.exitCode = code ?? undefined;
		job.signal = signal ?? undefined;
		if (job.timeout) clearTimeout(job.timeout);
		if (job.killTimer) clearTimeout(job.killTimer);
		if (spawnError) {
			job.stderr.append(`${job.stderr.text() ? "\n" : ""}${spawnError.message}\n`);
			job.status = "failed";
		} else if (job.killReason === "timeout") job.status = "timed_out";
		else if (job.killReason) job.status = "killed";
		else job.status = code === 0 ? "completed" : "failed";
		job.resolveCompletion();
		trimRetained();

		if (!job.suppressPersistence && job.sessionGeneration === sessionGeneration) {
			const persisted = snapshot(job, PERSISTED_OUTPUT_BYTES);
			pi.appendEntry(ENTRY_TYPE, persisted);
			const project = job.cwd.split("/").filter(Boolean).pop() || "pi";
			pi.events.emit(NOTIFICATION_EVENT, {
				title: `${project}: background job ${job.status}`,
				body: `${job.id}: ${compactCommand(job.command, 150)}`,
			});
			activeCtx?.ui.notify?.(`${job.id} ${job.status}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}.`, job.status === "completed" ? "info" : "warning");
		}
	};
	const startJob = (params: { command: string; description?: string; cwd?: string; timeoutSeconds?: number }, ctx: any): ManagedJob => {
		if (runningJobs().length >= MAX_CONCURRENT_JOBS) throw new Error(`At most ${MAX_CONCURRENT_JOBS} background jobs may run at once`);
		const command = params.command.trim();
		if (!command) throw new Error("Background command must not be empty");
		const timeoutSeconds = params.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS)) {
			throw new Error(`timeoutSeconds must be between 1 and ${MAX_TIMEOUT_SECONDS}`);
		}
		const cwd = resolve(ctx.cwd, params.cwd?.trim() || ".");
		const description = compactCommand(params.description?.trim() || command, 80);
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise; });
		const job: ManagedJob = {
			id: jobId(description, command),
			description,
			command,
			cwd,
			status: "running",
			startedAt: Date.now(),
			stdout: new BoundedOutput(),
			stderr: new BoundedOutput(),
			completion,
			resolveCompletion,
			finalized: false,
			suppressPersistence: false,
			sessionGeneration,
		};
		jobs.set(job.id, job);
		const child = spawn("/bin/bash", ["-lc", command], {
			cwd,
			env: process.env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.process = child;
		child.stdout.on("data", (chunk: Buffer) => job.stdout.append(chunk));
		child.stderr.on("data", (chunk: Buffer) => job.stderr.append(chunk));
		child.once("error", (error) => finalize(job, null, null, error));
		child.once("close", (code, signal) => finalize(job, code, signal));
		if (timeoutSeconds !== undefined) {
			job.timeout = setTimeout(() => requestKill(job, "timeout"), timeoutSeconds * 1000);
			job.timeout.unref?.();
		}
		return job;
	};
	const waitForJob = async (job: ManagedJob, signal?: AbortSignal) => {
		if (job.status !== "running") return;
		if (!signal) return job.completion;
		await Promise.race([
			job.completion,
			new Promise<void>((resolvePromise) => {
				if (signal.aborted) resolvePromise();
				else signal.addEventListener("abort", () => resolvePromise(), { once: true });
			}),
		]);
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
		if (job.status !== "running") return false;
		if (!ctx.hasUI && ctx.mode !== "tui") return false;
		return ctx.ui.confirm("Stop background job?", `${job.id}\n${job.command}\n\nThis sends SIGTERM to the process group, then SIGKILL after ${KILL_GRACE_MS / 1000}s if needed.`);
	};

	pi.registerEntryRenderer<JobSnapshot>(ENTRY_TYPE, (entry: any, options: any, theme: any) =>
		jobEntry(entry.data as JobSnapshot, Boolean(options.expanded), theme));

	pi.registerTool({
		name: "background_bash",
		label: "Background Bash",
		description: "Start an explicit shell command in a managed background process. Returns immediately with a job ID. Use job_output to inspect it and job_kill to stop it.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run" },
				description: { type: "string", description: "Short human-readable job name" },
				cwd: { type: "string", description: "Working directory, relative to the current project unless absolute" },
				timeoutSeconds: { type: "number", description: `Optional timeout from 1 to ${MAX_TIMEOUT_SECONDS} seconds` },
				reasoning: { type: "string", description: "Goal or intent behind starting this background job" },
			},
			required: ["command", "reasoning"],
		} as any,
		promptGuidelines: ["Use background_bash only for commands that benefit from running asynchronously. Never background ordinary quick commands automatically."],
		executionMode: "sequential",
		async execute(_id: string, params: any, _signal: AbortSignal, _update: any, ctx: any) {
			const job = startJob(params, ctx);
			return {
				content: [{ type: "text", text: `Background job ${job.id} started in ${job.cwd}. Use job_output with job_id=${job.id} to inspect it.` }],
				details: snapshot(job, TOOL_OUTPUT_BYTES),
			};
		},
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("accent", "●")} ${theme.bold("Starting background job")} ${args.reasoning || highlightShellCommand(compactCommand(args.command || ""), theme)}`, 0, 0),
		renderResult: (result: any, _options: any, theme: any) => {
			const data = result.details as JobSnapshot | undefined;
			return data ? jobEntry(data, false, theme) : new Text(result?.content?.[0]?.text ?? "", 0, 0);
		},
		renderShell: "self",
	});

	pi.registerTool({
		name: "job_output",
		label: "Job Output",
		description: "Read bounded stdout/stderr from a managed background job. Optionally wait until it finishes.",
		parameters: {
			type: "object",
			properties: {
				job_id: { type: "string", description: "Full job ID or an unambiguous prefix" },
				wait: { type: "boolean", description: "Wait for completion before returning output", default: false },
			},
			required: ["job_id"],
		} as any,
		executionMode: "sequential",
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const job = findJob(params.job_id);
			if (!job) throw new Error(`Background job not found or prefix is ambiguous: ${params.job_id}`);
			if (params.wait) await waitForJob(job, signal);
			const data = snapshot(job, TOOL_OUTPUT_BYTES);
			return { content: [{ type: "text", text: formatSnapshotText(data) }], details: data };
		},
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("accent", "•")} Inspecting background job ${theme.fg("accent", args.job_id ?? "")}`, 0, 0),
		renderResult: (result: any, options: any, theme: any) => {
			const data = result.details as JobSnapshot | undefined;
			return data ? jobEntry(data, Boolean(options.expanded), theme) : new Text(theme.fg("error", result?.content?.[0]?.text ?? "Job not found"), 0, 0);
		},
		renderShell: "self",
	});

	pi.registerTool({
		name: "job_kill",
		label: "Stop Job",
		description: "Stop a managed background job after explicit user confirmation.",
		parameters: {
			type: "object",
			properties: { job_id: { type: "string", description: "Full job ID or an unambiguous prefix" } },
			required: ["job_id"],
		} as any,
		executionMode: "sequential",
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: any) {
			const job = findJob(params.job_id);
			if (!job) throw new Error(`Background job not found or prefix is ambiguous: ${params.job_id}`);
			if (job.status !== "running") return { content: [{ type: "text", text: `${job.id} is already ${job.status}.` }], details: snapshot(job, TOOL_OUTPUT_BYTES) };
			if (!(await confirmKill(job, ctx))) throw new Error(`Did not stop ${job.id}; user confirmation was not granted.`);
			requestKill(job, "user");
			return { content: [{ type: "text", text: `Sent SIGTERM to background job ${job.id}.` }], details: snapshot(job, TOOL_OUTPUT_BYTES) };
		},
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("warning", "■")} Requesting stop for ${args.job_id ?? "job"}`, 0, 0),
		renderResult: (result: any, _options: any, theme: any, context: any) => new Text(context?.isError ? theme.fg("warning", result?.content?.[0]?.text ?? "") : result?.content?.[0]?.text ?? "", 0, 0),
		renderShell: "self",
	});

	pi.registerCommand("jobs", {
		description: "List, inspect, or stop managed background shell jobs",
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/, 2);
			if (action === "output" && id) {
				const job = findJob(id);
				if (!job) { ctx.ui.notify(`Job not found or prefix ambiguous: ${id}`, "warning"); return; }
				await showOutput(job, ctx);
				return;
			}
			if ((action === "kill" || action === "stop") && id) {
				const job = findJob(id);
				if (!job) { ctx.ui.notify(`Job not found or prefix ambiguous: ${id}`, "warning"); return; }
				if (job.status !== "running") { ctx.ui.notify(`${job.id} is already ${job.status}.`, "info"); return; }
				if (await confirmKill(job, ctx)) requestKill(job, "user");
				return;
			}
			if (action && action !== "list") {
				ctx.ui.notify("Usage: /jobs [list|output <id>|kill <id>]", "warning");
				return;
			}
			const ordered = [...jobs.values()].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
			if (ordered.length === 0) { ctx.ui.notify("No background jobs in this session.", "info"); return; }
			const labels = ordered.map((job) => `${statusSymbol(job.status)} ${job.id} · ${job.status} · ${compactDuration(duration(job))} · ${compactCommand(job.command, 72)}`);
			const selected = await ctx.ui.select(`Background jobs (${runningJobs().length} running)`, labels);
			if (!selected) return;
			const job = ordered[labels.indexOf(selected)];
			if (!job) return;
			const choice = await ctx.ui.select(`${job.id}\n${job.command}`, job.status === "running" ? ["View output", "Stop job", "Cancel"] : ["View output", "Cancel"]);
			if (choice === "View output") await showOutput(job, ctx);
			else if (choice === "Stop job" && await confirmKill(job, ctx)) requestKill(job, "user");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration += 1;
		activeCtx = ctx;
		jobs.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			const data = entry.data as JobSnapshot;
			if (data.status === "running") continue;
			jobs.set(data.id, restoredJob(data, sessionGeneration));
		}
		trimRetained();
	});

	pi.on("session_shutdown", () => {
		sessionGeneration += 1;
		for (const job of jobs.values()) {
			if (job.status !== "running") continue;
			job.suppressPersistence = true;
			requestKill(job, "shutdown");
		}
		jobs.clear();
		activeCtx = undefined;
	});
}
