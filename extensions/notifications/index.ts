import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
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

function sanitizeOsc9Message(message: string): string {
	return message
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function buildOsc9Sequence(message: string, tmux = Boolean(process.env.TMUX)): string {
	const osc = `\u001b]9;${sanitizeOsc9Message(message)}\u0007`;
	if (!tmux) return osc;
	return `\u001bPtmux;${osc.replace(/\u001b/g, "\u001b\u001b")}\u001b\\`;
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

	if (supportsOsc9Terminal()) {
		try {
			// Ghostty already displays the terminal title, so send
			// only the actionable response or request preview through OSC 9.
			process.stdout.write(buildOsc9Sequence(preview(body, 220)));
			return;
		} catch {
			// Fall through to the macOS notification backend.
		}
	}

	if (process.platform !== "darwin") return;
	const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
	execFile("osascript", ["-e", script, title, body], { timeout: 5_000 }, () => {});
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

	const notifyIfUnfocused = (title: string, body: string) => {
		// Ghostty creates the 🔔 unread-tab marker from OSC 9 when
		// the tab/window is not focused. Do not synthesize a bell in the title.
		if (!shouldEmitForFocus(focusAware, terminalFocused)) return;
		notify(title, body);
	};

	pi.events.on("notification", (event: unknown) => {
		if (!enabled || !event || typeof event !== "object") return;
		const payload = event as { title?: unknown; body?: unknown };
		if (typeof payload.title !== "string" || typeof payload.body !== "string") return;
		notifyIfUnfocused(payload.title, payload.body);
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
		completionNotifiedRun = runId;
		const project = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
		if (failure) notifyIfUnfocused(`${project}: tool failed`, failure);
		else notifyIfUnfocused(`${project}: turn complete`, finalResponse || "Agent turn complete");
	});
}
