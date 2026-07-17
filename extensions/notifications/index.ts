import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG = join(homedir(), ".pi", "agent", "notifications.json");
const DUPLICATE_WINDOW_MS = 5_000;
const GLOBAL_STATE_KEY = Symbol.for("pi.notifications.state");
const ENABLE_FOCUS_REPORTING = "\u001b[?1004h";
const DISABLE_FOCUS_REPORTING = "\u001b[?1004l";
const FOCUS_REPORT_PATTERN = /\u001b\[([IO])/g;

interface GlobalNotificationState {
	lastSignature?: string;
	lastSentAt?: number;
}

function globalNotificationState(): GlobalNotificationState {
	const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: GlobalNotificationState };
	return root[GLOBAL_STATE_KEY] ??= {};
}

function loadEnabled(): boolean {
	try { return JSON.parse(readFileSync(CONFIG, "utf8"))?.enabled !== false; } catch { return true; }
}
async function saveEnabled(enabled: boolean) {
	await mkdir(dirname(CONFIG), { recursive: true });
	await writeFile(CONFIG, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}
function textFromMessage(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join(" ");
}
function preview(text: string, limit = 180): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}
export function supportsOsc9Terminal(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
	if (!isTty) return false;
	const identity = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
	return ["ghostty", "iterm", "kitty", "warp", "wezterm"].some((terminal) => identity.includes(terminal));
}

export function parseFocusReports(data: string, initiallyFocused: boolean): { data: string; focused: boolean; changed: boolean } {
	let focused = initiallyFocused;
	let changed = false;
	const remaining = data.replace(FOCUS_REPORT_PATTERN, (_match, report: string) => {
		focused = report === "I";
		changed = true;
		return "";
	});
	return { data: remaining, focused, changed };
}

export function shouldEmitForFocus(focusAware: boolean, terminalFocused: boolean): boolean {
	return !focusAware || !terminalFocused;
}

function notify(title: string, body: string) {
	const state = globalNotificationState();
	const now = Date.now();
	const signature = `${title}\u0000${body}`;
	if (state.lastSignature === signature && now - (state.lastSentAt ?? 0) < DUPLICATE_WINDOW_MS) return;
	state.lastSignature = signature;
	state.lastSentAt = now;

	// Terminal bell only. Each terminal decides how to surface it:
	// terminal decides how to surface it: Ghostty shows the 🔔 unread-tab
	// marker + dock bounce, iTerm/WezTerm/Kitty play a sound or show a marker,
	// and plain terminals may do nothing. Wrap in tmux passthrough when inside
	// tmux so the BEL reaches the outer terminal instead of being consumed by
	// tmux itself.
	const tmux = Boolean(process.env.TMUX);
	const bell = "\x07";
	const seq = tmux ? `\u001bPtmux;${bell.replace(/\u001b/g, "\u001b\u001b")}\u001b\\` : bell;
	try { process.stdout.write(seq); } catch { /* terminal not writable */ }
}

type GoalStatus = "active" | "paused" | "blocked" | "complete";

function isGoalStatus(status: unknown): status is GoalStatus {
	return status === "active" || status === "paused" || status === "blocked" || status === "complete";
}

function isTerminalGoalStatus(status: GoalStatus): boolean {
	return status === "blocked" || status === "complete";
}

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let finalResponse = "";
	let failure: string | undefined;
	let runId = 0;
	let completionNotifiedRun = -1;
	let inputNotifiedRun = -1;
	let terminalFocused = true;
	let focusAware = false;
	let unsubscribeTerminalInput: (() => void) | undefined;
	let project = "pi";
	let goalStatus: GoalStatus | undefined;
	let goalActiveThisRun = false;

	const notifyIfUnfocused = (title: string, body: string) => {
		// The bell surfaces as the 🔔 unread-tab marker in Ghostty
		// (and similar in iTerm/WezTerm/Kitty). Only ring when unfocused.
		if (!shouldEmitForFocus(focusAware, terminalFocused)) return;
		notify(title, body);
	};

	pi.events.on("notification", (event: unknown) => {
		if (!enabled || !event || typeof event !== "object") return;
		const payload = event as { title?: unknown; body?: unknown };
		if (typeof payload.title !== "string" || typeof payload.body !== "string") return;
		notifyIfUnfocused(payload.title, payload.body);
	});

	pi.events.on("goal:changed", (event: unknown) => {
		const previousStatus = goalStatus;
		const nextStatus = event && typeof event === "object" && isGoalStatus((event as { status?: unknown }).status)
			? (event as { status: GoalStatus }).status
			: undefined;
		goalStatus = nextStatus;
		if (nextStatus === "active") goalActiveThisRun = true;
		if (!enabled || !previousStatus || !nextStatus || previousStatus === nextStatus) return;
		if (!isTerminalGoalStatus(nextStatus) || isTerminalGoalStatus(previousStatus)) return;

		completionNotifiedRun = runId;
		const objective = typeof (event as { objective?: unknown }).objective === "string"
			? preview((event as { objective: string }).objective, 160)
			: nextStatus === "complete" ? "Goal complete" : "Goal blocked";
		notifyIfUnfocused(`${project}: goal ${nextStatus}`, objective);
	});

	pi.registerCommand("notifications", {
		description: "Enable or disable desktop notifications",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action || action === "status") return ctx.ui.notify(`Desktop notifications are ${enabled ? "on (unfocused tabs only)" : "off"}.`, "info");
			if (action !== "on" && action !== "off") return ctx.ui.notify("Usage: /notifications on|off|status", "warning");
			enabled = action === "on";
			await saveEnabled(enabled);
			ctx.ui.notify(`Desktop notifications ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		finalResponse = "";
		failure = undefined;
		runId = 0;
		completionNotifiedRun = -1;
		inputNotifiedRun = -1;
		project = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
		goalStatus = undefined;
		goalActiveThisRun = false;
		terminalFocused = true;
		focusAware = ctx.mode === "tui" && supportsOsc9Terminal();
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (focusAware) {
			unsubscribeTerminalInput = ctx.ui.onTerminalInput((data: string) => {
				const parsed = parseFocusReports(data, terminalFocused);
				if (!parsed.changed) return;
				terminalFocused = parsed.focused;
				return parsed.data ? { data: parsed.data } : { consume: true };
			});
			process.stdout.write(ENABLE_FOCUS_REPORTING);
		}
		// If the goal extension restored before notifications did, ask it to
		// re-emit. If it starts later, its own session_start emit will update us.
		pi.events.emit("goal:request", undefined);
	});
	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (focusAware && process.stdout.isTTY) process.stdout.write(DISABLE_FOCUS_REPORTING);
		focusAware = false;
		terminalFocused = true;
	});
	pi.on("agent_start", () => {
		runId += 1;
		finalResponse = "";
		failure = undefined;
		completionNotifiedRun = -1;
		inputNotifiedRun = -1;
		goalActiveThisRun = goalStatus === "active";
	});
	pi.on("tool_execution_start", (event: any, ctx: any) => {
		if (!enabled || event.toolName !== "questionnaire" || inputNotifiedRun === runId) return;
		inputNotifiedRun = runId;
		const project = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
		notifyIfUnfocused(`${project}: input required`, "The agent is waiting for answers.");
	});
	pi.on("tool_execution_end", (event: any) => {
		if (event.isError) {
			const text = event.result?.content?.find?.((item: any) => item?.type === "text")?.text;
			failure = preview(text || `${event.toolName} failed`, 120);
		}
	});
	pi.on("agent_end", (event: any) => {
		const assistant = [...event.messages].reverse().find((message: any) => message.role === "assistant");
		finalResponse = preview(textFromMessage(assistant));
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!enabled || completionNotifiedRun === runId) return;
		// Active goal loops can produce many routine turn boundaries. Stay quiet
		// until the goal reaches a terminal state, asks for input, or another
		// extension emits an explicit notification.
		if (goalStatus === "active" || goalActiveThisRun) return;
		completionNotifiedRun = runId;
		project = ctx.cwd.split("/").filter(Boolean).pop() || project;
		if (failure) notifyIfUnfocused(`${project}: tool failed`, failure);
		else notifyIfUnfocused(`${project}: turn complete`, finalResponse || "Agent turn complete");
	});
}
