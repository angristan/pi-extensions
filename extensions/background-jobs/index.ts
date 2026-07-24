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
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { fitToolLine, renderCommandOutput } from "../better-native-pi/core.js";
import { registerOverlayCard } from "../overlay-stack/index.js";
import { BoundedOutput, CursorOutput, sanitizeTerminalOutput, type CursorRead } from "./output.js";
import {
	CoalescedRefresh,
	LIVE_REFRESH_FALLBACK_MS,
} from "./refresh.js";
import {
	BASH_SESSION_ENV_GUIDELINE,
	clearBackgroundTerminalService,
	hasBetterNativeBashIntegration,
	setBackgroundTerminalService,
	type BackgroundTerminalService,
} from "./service.js";
import { isPtySupported, spawnTerminal } from "./terminal-process.js";

export { BoundedOutput, CursorOutput } from "./output.js";

const ENTRY_TYPE = "background-job";
const STATUS_KEY = "background-jobs";
const OVERLAY_WIDTH = 58;
const OVERLAY_JOB_ROWS = 2;
const OVERLAY_MAX_ROWS = 7;
const MAX_CONCURRENT_JOBS = 16;
const MAX_RETAINED_JOBS = 50;
const TOOL_OUTPUT_BYTES = 24 * 1024;
const PARTIAL_OUTPUT_BYTES = 4 * 1024;
const PERSISTED_OUTPUT_BYTES = 8 * 1024;
const VIEWER_OUTPUT_BYTES = 64 * 1024;
const TERMINAL_TOOL_NAMES = ["job_output", "terminal_write", "job_kill"] as const;
const TERMINAL_TOOL_NAME_SET = new Set<string>(TERMINAL_TOOL_NAMES);
const PI_SESSION_ENV_KEYS = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

function bashSessionEnvironment(ctx: any, getThinkingLevel: () => unknown): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of PI_SESSION_ENV_KEYS) delete env[key];

	const sessionId = ctx.sessionManager?.getSessionId?.();
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	const provider = ctx.model?.provider;
	const model = ctx.model?.id;
	const thinkingLevel = ctx.thinkingLevel ?? getThinkingLevel();

	if (typeof sessionId === "string" && sessionId) env.PI_SESSION_ID = sessionId;
	if (typeof sessionFile === "string" && sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (typeof provider === "string" && provider) env.PI_PROVIDER = provider;
	if (typeof model === "string" && model) env.PI_MODEL = model;
	if (typeof thinkingLevel === "string" && thinkingLevel) env.PI_REASONING_LEVEL = thinkingLevel;
	return env;
}

// ---------------------------------------------------------------------------
// Last-resort reaper: prevent orphaned managed terminals on hard process exit.
// ---------------------------------------------------------------------------
// Normal exits, including SIGINT/SIGTERM/SIGHUP, flow through session_shutdown,
// which performs the graceful SIGTERM -> grace period -> SIGKILL sequence.
// Registering our own signal listeners would suppress Node's default signal
// behavior and could race Pi's shutdown handler, so this fallback intentionally
// runs only from the synchronous process `exit` event.
const liveJobPids = new Set<number>();
let lastResortReaperArmed = false;

function reapLiveJobPidsSync(): void {
	for (const pid of liveJobPids) {
		// Match requestKill's escalation: SIGKILL the whole process group. The
		// wrapper pid is the group leader (spawnTerminal uses detached: true),
		// so -pid reaches every descendant including `trap '' TERM` survivors.
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
		}
	}
	liveJobPids.clear();
}

function armLastResortReaper(): void {
	if (lastResortReaperArmed) return;
	lastResortReaperArmed = true;
	// This hook must remain synchronous. SIGKILL cannot be handled, so cleanup
	// after the parent itself receives SIGKILL is inherently impossible.
	process.on("exit", reapLiveJobPidsSync);
}

function trackJobPid(pid: number | undefined): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	liveJobPids.add(pid);
	armLastResortReaper();
}

function untrackJobPid(pid: number | undefined): void {
	if (Number.isInteger(pid)) liveJobPids.delete(pid!);
}
// Model-controllable output budget, mirroring codex's `max_output_tokens`.
// Default 10000 tokens; pi doesn't tokenize, so we map tokens -> bytes at
// ~4 bytes/token (matching codex's UNIFIED_EXEC_OUTPUT_MAX_BYTES / 4) and cap
// the byte budget at MAX_OUTPUT_BYTES to bound memory.
const DEFAULT_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_BYTES = 1_024 * 1_024; // 1 MiB hard cap
const BYTES_PER_TOKEN = 4;
function outputBytesForTokens(tokens?: number): number {
	if (!Number.isInteger(tokens) || tokens < 1) return TOOL_OUTPUT_BYTES;
	return Math.min(tokens * BYTES_PER_TOKEN, MAX_OUTPUT_BYTES);
}
const KILL_GRACE_MS = 5_000;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_YIELD_MS = 10_000;
const DEFAULT_POLL_MS = 5_000;
const MAX_POLL_MS = 5 * 60 * 1_000;
// `wait: true` becomes a bounded completion-poll rather than an infinite block.
// Cap it at MAX_POLL_MS so a stuck process still returns control to the model,
// which can then re-poll or kill. No kill happens here — this is a soft wait.
const DEFAULT_WAIT_COMPLETION_MS = MAX_POLL_MS;
const INTERACTION_REASONING_DESCRIPTION = "Short phrase stating the goal behind this terminal interaction, not the mechanics or command";

export type JobStatus = "running" | "stopping" | "completed" | "failed" | "killed" | "timed_out";

export interface JobSnapshot {
	id: string;
	description: string;
	command: string;
	cwd: string;
	status: JobStatus;
	tty?: boolean;
	backgrounded?: boolean;
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
	/** Wall-clock time when this immutable tool-result snapshot was observed. */
	observedAt?: number;
	output?: string;
	cursor?: number;
	outputOmittedBytes?: number;
}

interface JobViewerSnapshot extends JobSnapshot {
	output: string;
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
	backgrounded: boolean;
	killReason?: "user" | "timeout" | "shutdown";
	suppressPersistence: boolean;
	sessionGeneration: number;
	activityListeners: Set<() => void>;
}

interface BackgroundJobsOptions {
	killGraceMs?: number;
	registerOverlayCard?: typeof registerOverlayCard;
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

function duration(job: Pick<JobSnapshot, "startedAt" | "endedAt">, now = Date.now()): number {
	return Math.max(0, (job.endedAt ?? now) - job.startedAt);
}

function compactCommand(command: unknown, limit = 100): string {
	// Defensive: several render paths feed this from persisted/restored job
	// snapshots or fallback details that may be missing fields. Coerce to a
	// string so a malformed `details` object can never crash the TUI render.
	const text = typeof command === "string" ? command : String(command ?? "");
	const oneLine = text.replace(/\s+/g, " ").trim();
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

function isJobStatus(status: unknown): status is JobStatus {
	return status === "running" || status === "stopping" || status === "completed" || status === "failed" || status === "killed" || status === "timed_out";
}

function displayStatusText(text: string): string {
	return text.replace(/\btimed_out\b/g, "timed out");
}

function textResult(result: any): string {
	const content = result?.content?.[0];
	return content?.type === "text" ? content.text : "";
}

function renderJobKillResult(result: any, theme: any, context: any): Text {
	const text = displayStatusText(textResult(result));
	if (!text) return new Text("", 0, 0);
	const status = result?.details?.status;
	if (isJobStatus(status)) return new Text(`${theme.fg(statusColor(status), statusSymbol(status))} ${text}`, 0, 0);
	if (context?.isError) return new Text(`${theme.fg("warning", "■")} ${theme.fg("warning", text)}`, 0, 0);
	return new Text(text, 0, 0);
}

function renderOverlayJob(job: ManagedJob, width: number, theme: any): string[] {
	const mark = theme.fg(statusColor(job.status), statusSymbol(job.status));
	const name = theme.bold(compactCommand(job.description, Math.max(16, width - 4)));
	const headline = truncateToWidth(`${mark} ${name}`, width, "…");
	const command = compactCommand(job.command, Math.max(24, width * 2));
	return [
		headline,
		truncateToWidth(theme.fg("dim", `  ${command}${job.tty ? " · tty" : ""}`), width, "…"),
	];
}

function renderJobsOverlayBody(jobs: ManagedJob[], width: number, maxHeight: number, theme: any): string[] {
	const rowBudget = Math.max(0, Math.min(OVERLAY_MAX_ROWS, maxHeight));
	if (rowBudget < OVERLAY_JOB_ROWS || jobs.length === 0) return [];
	const shownCount = Math.min(jobs.length, Math.floor(rowBudget / OVERLAY_JOB_ROWS));
	const lines = jobs.slice(0, shownCount).flatMap((job) => renderOverlayJob(job, width, theme));
	const hidden = jobs.length - shownCount;
	if (hidden > 0 && lines.length < rowBudget) lines.push(theme.fg("dim", `… ${hidden} more · /ps`));
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

function snapshot(job: ManagedJob, outputLimit?: number): JobSnapshot {
	return {
		id: job.id,
		description: job.description,
		command: job.command,
		cwd: job.cwd,
		status: job.status,
		tty: job.tty,
		backgrounded: job.backgrounded,
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

function viewerSnapshot(job: ManagedJob): JobViewerSnapshot {
	return {
		id: job.id,
		description: job.description,
		command: job.command,
		cwd: job.cwd,
		status: job.status,
		tty: job.tty,
		backgrounded: job.backgrounded,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		signal: job.signal,
		stdout: "",
		stderr: "",
		stdoutOmittedBytes: job.stdout.omittedBytes,
		stderrOmittedBytes: job.stderr.omittedBytes,
		outputCursor: job.output.cursor,
		output: job.output.read(0, VIEWER_OUTPUT_BYTES).text,
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
		backgrounded: Boolean(data.backgrounded),
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

function activeSnapshot(snapshot: Pick<JobSnapshot, "status">): boolean {
	return snapshot.status === "running" || snapshot.status === "stopping";
}

function viewerRevision(snapshot: JobViewerSnapshot): string {
	return [
		snapshot.status,
		snapshot.outputCursor,
		snapshot.endedAt,
		snapshot.exitCode,
		snapshot.signal,
		snapshot.stdoutOmittedBytes,
		snapshot.stderrOmittedBytes,
	].join(":");
}

function boundedViewerOutput(text: string, width: number, maxRows: number): string[] {
	const rowLimit = Math.max(1, maxRows);
	const inputLimit = Math.max(1_024, width * rowLimit * 4);
	let bounded = text;
	let omitted = false;
	if (bounded.length > inputLimit) {
		bounded = sanitizeTerminalOutput(bounded.slice(-inputLimit));
		omitted = true;
	}
	return renderCommandOutput(bounded, width, {
		maxRows: rowLimit,
		forceOmission: omitted,
		omissionText: () => "… earlier output omitted …",
	});
}

export class JobOutputViewer implements Focusable {
	private scroll = 0;
	private _focused = true;
	private pendingWhileUnfocused = false;
	private cachedWidth = 0;
	private cachedHeight = 0;
	private cachedLines: string[] = [];
	private currentSnapshot: JobViewerSnapshot;
	private lastRevision: string;
	private readonly refreshScheduler: CoalescedRefresh;
	private fallbackTimer?: ReturnType<typeof setInterval>;
	private unsubscribe?: () => void;

	constructor(
		private readonly getSnapshot: () => JobViewerSnapshot,
		private readonly subscribe: (listener: () => void) => () => void,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (result?: unknown) => void,
	) {
		this.currentSnapshot = getSnapshot();
		this.lastRevision = viewerRevision(this.currentSnapshot);
		this.refreshScheduler = new CoalescedRefresh(() => this.refreshIfChanged());
		if (activeSnapshot(this.currentSnapshot)) {
			this.unsubscribe = subscribe(() => this.scheduleRefresh());
			// A slow revision check covers missed process events without driving the UI.
			this.fallbackTimer = setInterval(() => this.scheduleRefresh(), LIVE_REFRESH_FALLBACK_MS);
			this.fallbackTimer.unref?.();
		}
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		if (value && this.pendingWhileUnfocused) {
			this.pendingWhileUnfocused = false;
			this.refreshScheduler.trigger();
		}
	}

	private scheduleRefresh(): void {
		if (!this.focused) {
			this.pendingWhileUnfocused = true;
			return;
		}
		this.refreshScheduler.trigger();
	}

	private refreshIfChanged(force = false): void {
		const next = this.getSnapshot();
		const revision = viewerRevision(next);
		if (!force && revision === this.lastRevision) return;
		this.currentSnapshot = next;
		this.lastRevision = revision;
		this.invalidate();
		this.tui.requestRender();
		if (!activeSnapshot(next)) this.stopLiveRefresh();
	}

	private stopLiveRefresh(): void {
		this.pendingWhileUnfocused = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.fallbackTimer) clearInterval(this.fallbackTimer);
		this.fallbackTimer = undefined;
	}

	private lines(width: number, bodyHeight: number): string[] {
		if (this.cachedWidth === width && this.cachedHeight === bodyHeight) return this.cachedLines;
		const data = this.currentSnapshot;
		const headerSources = [
			`${statusSymbol(data.status)} ${data.id} · ${data.status} · ${compactDuration(duration(data))}${data.tty ? " · tty" : ""}`,
			`cwd: ${data.cwd}`,
			`command: ${compactCommand(data.command, Math.max(120, width * 2))}`,
		];
		if (data.exitCode !== undefined) headerSources.push(`exit code: ${data.exitCode}`);
		if (data.signal) headerSources.push(`signal: ${data.signal}`);
		const header = headerSources.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
		const outputRows = boundedViewerOutput(data.output, width, Math.max(1, bodyHeight - header.length - 2));
		this.cachedWidth = width;
		this.cachedHeight = bodyHeight;
		this.cachedLines = [...header, "", data.tty ? "latest terminal output:" : "latest output:", ...outputRows];
		return this.cachedLines;
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		const height = Math.max(10, (process.stdout.rows || 24) - 5);
		const bodyHeight = height - 1;
		const lines = this.lines(max, bodyHeight);
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, max, "…"));
		while (visible.length < bodyHeight) visible.push("");
		return [...visible, truncateToWidth(this.theme.fg("dim", "↑↓/PgUp/PgDn · r refresh · q close"), max, "")];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") return this.done(undefined);
		if (data === "r") { this.refreshIfChanged(true); return; }
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - 10);
		else if (matchesKey(data, Key.pageDown)) this.scroll += 10;
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = 0;
		this.cachedHeight = 0;
		this.cachedLines = [];
	}

	dispose(): void {
		this.stopLiveRefresh();
		this.refreshScheduler.dispose();
	}
}

class TerminalInteractionComponent {
	private readonly observedAt: number;

	constructor(
		private readonly details: JobToolDetails | undefined,
		private readonly args: any,
		private readonly expanded: boolean,
		private readonly theme: any,
		private readonly action: "read" | "write",
	) {
		// Tool results are historical snapshots. Never let an active status make
		// an old transcript row depend on Date.now(): unrelated streaming renders
		// would mutate the off-screen row and force Pi to redraw all scrollback.
		this.observedAt = details?.observedAt ?? Date.now();
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		const details = this.details;
		if (!details) return [];
		const wrote = this.action === "write" && typeof this.args?.chars === "string" && this.args.chars.length > 0;
		const verb = this.action === "read" ? "Read from" : wrote ? "Interacted with" : "Waited for";
		const color = statusColor(details.status);
		const name = details.description || details.id;
		const reasoning = typeof this.args?.reasoning === "string" ? compactCommand(this.args.reasoning, 96) : "";
		const terminal = this.theme.fg("mdHeading", compactCommand(name, 64));
		const goal = reasoning ? ` ${this.theme.fg("dim", "to")} ${this.theme.fg("accent", reasoning)}` : "";
		const elapsed = compactDuration(duration(details, this.observedAt));
		const header = `${this.theme.fg(color, "•")} ${verb} ${terminal}${goal} ${this.theme.fg("dim", `· ${details.status} in ${elapsed}`)}`;
		const output = details.output?.replace(/\s+$/, "") ?? "";
		const rows = renderCommandOutput(output, max, {
			maxRows: this.expanded ? undefined : 5,
			emptyText: "(no new output)",
		});
		return [
			fitToolLine(header, max),
			...rows,
			fitToolLine(`  └ ${this.theme.fg(color, statusSymbol(details.status))} ${this.theme.fg("dim", `${details.id}${details.tty ? " · tty" : ""}`)}`, max),
		];
	}

	invalidate(): void {}
}

export default function registerBackgroundJobs(pi: ExtensionAPI, options: BackgroundJobsOptions = {}) {
	const jobs = new Map<string, ManagedJob>();
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	const registerCard = options.registerOverlayCard ?? registerOverlayCard;
	let activeCtx: any;
	let sessionGeneration = 0;

	const deactivateTerminalTools = () => {
		const active = pi.getActiveTools();
		if (!active.some((name) => TERMINAL_TOOL_NAME_SET.has(name))) return;
		pi.setActiveTools(active.filter((name) => !TERMINAL_TOOL_NAME_SET.has(name)));
	};
	const activateTerminalTools = () => {
		const active = pi.getActiveTools();
		const activeSet = new Set(active);
		const added = TERMINAL_TOOL_NAMES.filter((name) => !activeSet.has(name));
		if (added.length === 0) return;
		// Keep activation purely additive so providers with deferred tool loading
		// anchor these definitions at the yielded bash result without replacing or
		// invalidating the stable initial tool prefix.
		pi.setActiveTools([...active, ...added]);
	};
	const activeJobs = () => [...jobs.values()].filter(isActive);
	const activeBackgroundJobs = () => activeJobs()
		.filter((job) => job.backgrounded)
		.sort((a, b) => b.startedAt - a.startedAt);
	const overlayCard = registerCard({
		id: "background-jobs",
		order: 16,
		width: OVERLAY_WIDTH,
		minBodyHeight: OVERLAY_JOB_ROWS,
		minTerminalWidth: 90,
		minTerminalHeight: 10,
		visible: () => activeBackgroundJobs().length > 0,
		title: (theme) => {
			const count = activeBackgroundJobs().length;
			return `${theme.bold(" Jobs ")}${theme.fg("accent", `● ${count} running`)} ${theme.fg("dim", "· /ps ")}`;
		},
		renderBody: (width, maxHeight, theme) => renderJobsOverlayBody(activeBackgroundJobs(), width, maxHeight, theme),
	});
	const updateUi = () => {
		// Clear the legacy footer key on reload; live job state belongs in the
		// shared top-right overlay alongside plans, goals, and subagents.
		activeCtx?.ui.setStatus(STATUS_KEY, undefined);
		overlayCard.invalidate();
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
		updateUi();
		emitActivity(job);
		return true;
	};
	finalize = (job: ManagedJob, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
		if (job.finalized) return;
		untrackJobPid(job.process?.pid);
		untrackJobPid(job.ptyPid);
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
		updateUi();

		if (!job.suppressPersistence && job.sessionGeneration === sessionGeneration) {
			pi.appendEntry(ENTRY_TYPE, snapshot(job, PERSISTED_OUTPUT_BYTES));
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
			backgrounded: false,
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
				env: bashSessionEnvironment(ctx, () => pi.getThinkingLevel?.()),
				onStdout: (chunk) => appendOutput(job, "stdout", chunk),
				onStderr: (chunk) => appendOutput(job, "stderr", chunk),
				onPtyPid: (pid) => {
					job.ptyPid = pid;
					// The PTY child is a separate session leader (expect/script), so it
					// needs independent tracking for the last-resort reaper too.
					trackJobPid(pid);
				},
			});
		} catch (error) {
			jobs.delete(job.id);
			throw error;
		}
		job.process.stdin?.on("error", () => {});
		// Track the spawned wrapper pid so the last-resort reaper can SIGKILL
		// the whole process tree even when pi exits without firing
		// session_shutdown (crash, emergencyTerminalExit, signal). Untrack on
		// close so the set stays bounded and we never signal a recycled pid.
		trackJobPid(job.process.pid);
		job.process.once("error", (error) => {
			untrackJobPid(job.process?.pid);
			finalize(job, null, null, error);
		});
		job.process.once("close", (code, signal) => {
			untrackJobPid(job.process?.pid);
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
			untrackJobPid(job.ptyPid);
			finalize(job, code, signal);
		});
		if (timeoutSeconds !== undefined) {
			job.timeout = setTimeout(() => requestKill(job, "timeout"), timeoutSeconds * 1000);
			job.timeout.unref?.();
		}
		updateUi();
		return job;
	};
	const waitForCompletion = async (job: ManagedJob, signal: AbortSignal | undefined, waitMs = DEFAULT_WAIT_COMPLETION_MS) => {
		// Never block unboundedly: wait for completion OR a soft deadline,
		// whichever comes first, then return so the model can re-decide
		// (re-poll / kill / move on). The process is NOT killed here; only an
		// explicit hard timeout or stop request ends a still-running terminal.
		if (!isActive(job) || waitMs <= 0) return;
		if (signal?.aborted) return;
		await new Promise<void>((resolvePromise) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (deadline) clearTimeout(deadline);
				signal?.removeEventListener("abort", finish);
				resolvePromise();
			};
			const deadline = setTimeout(finish, waitMs);
			job.completion.then(finish);
			signal?.addEventListener("abort", finish, { once: true });
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
	const readDelta = (job: ManagedJob, cursor: number, advanceAgentCursor: boolean, outputBytes: number = TOOL_OUTPUT_BYTES): { read: CursorRead; details: JobToolDetails } => {
		const read = job.output.read(cursor, outputBytes);
		if (advanceAgentCursor) job.agentCursor = read.cursor;
		return {
			read,
			details: {
				managedTerminal: true,
				...snapshot(job, PERSISTED_OUTPUT_BYTES),
				observedAt: Date.now(),
				output: read.text,
				cursor: read.cursor,
				outputOmittedBytes: read.omittedBytes,
			},
		};
	};
	const writeInput = async (job: ManagedJob, chars: string, closeStdin: boolean) => {
		if (!isActive(job)) return;
		if (!job.tty) throw new Error(`Terminal ${job.id} does not accept input: started without tty=true`);
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
			new JobOutputViewer(
				() => viewerSnapshot(job),
				(listener) => {
					job.activityListeners.add(listener);
					return () => job.activityListeners.delete(listener);
				},
				tui,
				theme,
				done,
			), {
				overlay: true,
				overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 },
			});
	};
	const confirmKill = async (job: ManagedJob, ctx: any): Promise<boolean> => {
		if (!isActive(job) || job.killReason) return false;
		if (!ctx.hasUI && ctx.mode !== "tui") return false;
		return ctx.ui.confirm("Stop background job?", `${job.id}\n${job.command}\n\nThis sends SIGTERM to the process tree, then SIGKILL after ${killGraceMs / 1000}s if needed.`);
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
		const update = () => {
			if (!onUpdate) return;
			const partial = job.output.read(initialCursor, PARTIAL_OUTPUT_BYTES);
			onUpdate({
				content: [{ type: "text", text: formatDeltaText(job, partial) }],
				details: { managedTerminal: true, ...snapshot(job, PERSISTED_OUTPUT_BYTES) },
			});
		};
		const partialUpdates = new CoalescedRefresh(update);
		const scheduleUpdate = () => partialUpdates.trigger();
		job.activityListeners.add(scheduleUpdate);
		// Mount the managed-terminal card immediately, then batch output bursts.
		update();
		try { await waitForYield(job, yieldMs, signal); } finally {
			job.activityListeners.delete(scheduleUpdate);
			partialUpdates.dispose();
		}
		const yielded = isActive(job);
		if (yielded) {
			// Until the initial yield window expires, this is still foreground tool
			// execution. Only advertise footer state once the agent can move on and
			// the terminal is genuinely managed in the background. Activate controls
			// before returning so the next model turn can act on this terminal ID.
			job.backgrounded = true;
			activateTerminalTools();
			updateUi();
		}
		const outputBytes = outputBytesForTokens(params.max_output_tokens);
		const { read, details } = readDelta(job, initialCursor, true, outputBytes);
		const prefix = yielded ? `Terminal ${job.id} is still running. Use terminal_write or job_output with job_id=${job.id}.\n` : "";
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
			// Fallback path: the job is not in the live map. This happens for
			// completed jobs evicted past MAX_RETAINED_JOBS, and — critically —
			// for persisted cards whose status is still `running`/`stopping`.
			// session_start intentionally skips restoring active jobs (their
			// process died with the previous session), so such an id can never
			// reappear here. Coerce stale active status to a terminal state before
			// the immutable transcript snapshot is cached.
			const fallbackDetails = fallback ?? {};
			const staleActive =
				fallbackDetails.status === "running" || fallbackDetails.status === "stopping";
			const details = staleActive ? { ...fallbackDetails, status: "killed" } : fallbackDetails;
			return {
				details,
				output: details.output ?? [details.stdout, details.stderr].filter(Boolean).join("\n"),
			};
		},
		subscribe: (id, listener) => {
			const job = jobs.get(id);
			if (!job || !isActive(job)) return () => {};
			job.activityListeners.add(listener);
			return () => job.activityListeners.delete(listener);
		},
	};
	setBackgroundTerminalService(terminalService);

	const registerStandaloneBash = () => {
		pi.registerTool({
			name: "bash",
			label: "bash",
			description: "Run a shell command. Quick commands return normally; long-running commands yield a managed terminal ID. Set tty=true for prompts and REPLs.",
			promptSnippet: "Run shell commands with automatic background yielding and optional PTY interaction",
			promptGuidelines: [BASH_SESSION_ENV_GUIDELINE],
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command to run" },
					timeout: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: `Optional hard timeout from 1 to ${MAX_TIMEOUT_SECONDS} seconds. Omit to let the command run until completion or an explicit stop.` },
					cwd: { type: "string", description: "Working directory, relative to the current project unless absolute" },
					tty: { type: "boolean", description: "Allocate a PTY for prompts, REPLs, and control characters", default: false },
					"yield-time_ms": { type: "integer", minimum: 250, maximum: 30_000, description: `Wait before yielding a terminal ID (default ${DEFAULT_YIELD_MS} ms)` },
					max_output_tokens: { type: "integer", minimum: 1, description: "Output byte budget in tokens (~4 bytes/token). Defaults to 10000; larger requests cap at 1 MiB." },
					reasoning: { type: "string", description: "Goal or intent behind running this command" },
				},
				required: ["command", "reasoning"],
			} as any,
			executionMode: "sequential",
			execute: executeUnified,
			renderCall: (args: any, theme: any) => new Text(`${theme.fg("accent", "●")} ${theme.bold("Running bash")} ${compactCommand(args.reasoning || args.command || "")}`, 0, 0),
			renderResult: (result: any) => new Text(result?.content?.[0]?.text ?? "", 0, 0),
			renderShell: "self",
		});
	};

	// Completion entries persist final state without an entry renderer. The
	// original tool card reads the live/restored job and updates in place. An
	// empty component still receives Pi's custom-entry spacer, so registering one
	// would add a blank transcript row for every completed command.

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
				waitMs: { type: "integer", minimum: 0, maximum: MAX_POLL_MS, description: `Wait this many milliseconds for new output. Also caps wait:true. Defaults to 0 (instant) for read polls, ${DEFAULT_WAIT_COMPLETION_MS} ms for wait:true.` },
				wait: { type: "boolean", description: "Wait for the terminal to finish, bounded by waitMs (no kill; returns 'still running' if not done).", default: false },
				max_output_tokens: { type: "integer", minimum: 1, description: `Output byte budget, expressed in tokens (~${BYTES_PER_TOKEN} bytes/token). Defaults to ${DEFAULT_OUTPUT_TOKENS}; larger requests cap at ${MAX_OUTPUT_BYTES} bytes.` },
			},
			required: ["reasoning", "job_id"],
		} as any,
		executionMode: "sequential",
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const job = findJob(params.job_id);
			if (!job) throw new Error(`Background terminal not found or prefix is ambiguous: ${params.job_id}`);
			const explicitCursor = params.cursor !== undefined;
			const cursor = explicitCursor ? params.cursor : job.agentCursor;
			if (!Number.isInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
			const waitMs = params.waitMs ?? 0;
			if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_POLL_MS) throw new Error(`waitMs must be an integer between 0 and ${MAX_POLL_MS}`);
			if (params.wait) await waitForCompletion(job, signal, params.waitMs ?? DEFAULT_WAIT_COMPLETION_MS);
			else await waitForActivity(job, cursor, waitMs, signal);
			const { read, details } = readDelta(job, cursor, !explicitCursor, outputBytesForTokens(params.max_output_tokens));
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
				max_output_tokens: { type: "integer", minimum: 1, description: `Output byte budget, expressed in tokens (~${BYTES_PER_TOKEN} bytes/token). Defaults to ${DEFAULT_OUTPUT_TOKENS}; larger requests cap at ${MAX_OUTPUT_BYTES} bytes.` },
			},
			required: ["reasoning", "job_id"],
		} as any,
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
			const { read, details } = readDelta(job, cursor, true, outputBytesForTokens(params.max_output_tokens));
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
		renderCall: (args: any, theme: any) => new Text(`${theme.fg("warning", "◌")} Stopping ${args.job_id ?? "terminal"}`, 0, 0),
		renderResult: (result: any, _options: any, theme: any, context: any) => renderJobKillResult(result, theme, context),
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
		const choices = isActive(job) ? ["View latest output", "Stop terminal", "Cancel"] : ["View latest output", "Cancel"];
		const choice = await ctx.ui.select(`${job.id}\n${job.command}`, choices);
		if (choice === "View latest output") await showOutput(job, ctx);
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
		// Each extension owns a complete standalone Bash tool. When better-native-pi
		// is present, it owns the combined definition and uses this service backend.
		if (!hasBetterNativeBashIntegration()) registerStandaloneBash();
		// Tool registration makes every definition active by default. Most sessions
		// never yield a command, so keep terminal controls out of the initial model
		// context and add them only when executeUnified returns a live terminal ID.
		deactivateTerminalTools();
		sessionGeneration += 1;
		activeCtx = ctx;
		jobs.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data) continue;
			const data = entry.data as JobSnapshot;
			if (data.status === "running" || data.status === "stopping") continue;
			jobs.set(data.id, restoredJob(data, sessionGeneration));
		}
		trimRetained();
		updateUi();
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
		overlayCard.invalidate();
		clearBackgroundTerminalService(terminalService);
		activeCtx = undefined;
	});
}
