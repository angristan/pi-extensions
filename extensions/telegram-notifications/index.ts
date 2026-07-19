import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	resolveTelegramQuestion,
	sendTelegramHtmlMessage,
	sendTelegramMessage,
	sendTelegramQuestion,
	waitForTelegramAnswer,
	type SentTelegramQuestion,
} from "./bot-api";

export { sendTelegramMessage } from "./bot-api";

const QUESTION_WAITING_EVENT = "questions:waiting";
const QUESTION_ANSWER_EVENT = "questions:answer";
const QUESTION_RESOLVED_EVENT = "questions:resolved";
const DEFAULT_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 7 * 24 * 60;

export interface TelegramConfig {
	botToken: string;
	chatId: string;
	delayMinutes: number;
	enabled: boolean;
}

export interface WaitingQuestion {
	requestId: string;
	question: string;
	options: string[];
	allowOther: boolean;
	index: number;
	total: number;
	secret: boolean;
}

interface RuntimeDependencies {
	loadConfig?: () => TelegramConfig | undefined;
	saveConfig?: (config: TelegramConfig) => Promise<void>;
	sendMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendRenderedMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<SentTelegramQuestion>;
	sendQuestion?: (config: TelegramConfig, text: string, question: WaitingQuestion, signal?: AbortSignal) => Promise<SentTelegramQuestion>;
	waitForAnswer?: (config: TelegramConfig, sent: SentTelegramQuestion, question: WaitingQuestion, signal: AbortSignal) => Promise<string>;
	resolveQuestion?: (config: TelegramConfig, sent: SentTelegramQuestion, text: string) => Promise<void>;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "telegram-notifications.json");
}

function normalizedConfig(value: unknown): TelegramConfig | undefined {
	if (!value || typeof value !== "object") return undefined;
	const config = value as Record<string, unknown>;
	const botToken = typeof config.botToken === "string" ? config.botToken.trim() : "";
	const chatId = typeof config.chatId === "string" ? config.chatId.trim() : "";
	const configuredDelay = typeof config.delayMinutes === "number" ? config.delayMinutes : DEFAULT_DELAY_MINUTES;
	if (!botToken || !chatId || !Number.isFinite(configuredDelay) || configuredDelay <= 0) return undefined;
	return {
		botToken,
		chatId,
		delayMinutes: Math.min(configuredDelay, MAX_DELAY_MINUTES),
		enabled: config.enabled !== false,
	};
}

export function loadTelegramConfig(path = configPath()): TelegramConfig | undefined {
	try {
		return normalizedConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

export async function saveTelegramConfig(config: TelegramConfig, path = configPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown error";
}

function parseWaitingQuestion(event: unknown): WaitingQuestion | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as Record<string, unknown>;
	if (typeof value.requestId !== "string" || typeof value.question !== "string") return undefined;
	if (!Number.isInteger(value.index) || !Number.isInteger(value.total)) return undefined;
	const index = value.index as number;
	const total = value.total as number;
	if (index < 1 || total < index) return undefined;
	const options = Array.isArray(value.options) && value.options.every((option) => typeof option === "string")
		? value.options as string[]
		: [];
	return {
		requestId: value.requestId,
		question: value.question,
		options,
		allowOther: value.allowOther !== false,
		index,
		total,
		secret: value.secret === true,
	};
}

function formatDelay(minutes: number): string {
	if (minutes < 1) {
		const seconds = Math.max(1, Math.round(minutes * 60));
		return `${seconds} second${seconds === 1 ? "" : "s"}`;
	}
	const value = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
	return `${value} minute${minutes === 1 ? "" : "s"}`;
}

export function escapeTelegramHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function preview(value: string, limit: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	const characters = [...normalized];
	return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : normalized;
}

function contextLabel(pi: ExtensionAPI, cwd: string): string {
	const sessionTitle = pi.getSessionName()?.trim();
	if (sessionTitle) return sessionTitle;
	const resolvedCwd = resolve(cwd);
	return resolvedCwd === resolve(homedir()) ? "pi" : basename(resolvedCwd) || "pi";
}

function messageContext(project: string, question: WaitingQuestion): string {
	return `<b>${escapeTelegramHtml(preview(project, 100))}</b> · Question ${question.index} of ${question.total}`;
}

export function formatWaitingMessage(project: string, question: WaitingQuestion, delayMinutes: number): string {
	if (question.secret) {
		return [
			"🔐 <b>Secret input needed</b>",
			messageContext(project, question),
			"",
			"A secret response is waiting in Pi.",
			"For your security, answer in the terminal.",
			"",
			`⏱ The agent has been waiting ${formatDelay(delayMinutes)} for your response.`,
		].join("\n");
	}
	const instruction = question.options.length === 0
		? "↩️ Reply to this message with your answer."
		: question.allowOther
			? "Choose below, or reply to this message."
			: "Choose an answer below.";
	return [
		"❓ <b>Input needed</b>",
		messageContext(project, question),
		"",
		`<blockquote>${escapeTelegramHtml(preview(question.question, 800))}</blockquote>`,
		`⏱ The agent has been waiting ${formatDelay(delayMinutes)} for your response.`,
		"",
		instruction,
	].join("\n");
}

export function formatResolvedMessage(
	project: string,
	question: WaitingQuestion,
	resolution?: { outcome: "answered" | "cancelled"; source: "tui" | "remote" },
	answer?: string,
): string {
	const heading = !resolution
		? "⚪ <b>Question closed</b>"
		: resolution.outcome === "cancelled"
			? "⚪ <b>Question cancelled in Pi</b>"
			: question.secret
				? "✅ <b>Answered securely in Pi</b>"
				: resolution.source === "remote"
					? "✅ <b>Answered in Telegram</b>"
					: "✅ <b>Answered in Pi</b>";
	const lines = [heading, messageContext(project, question)];
	if (question.secret) {
		if (resolution?.outcome === "cancelled") lines.push("", "No answer was submitted.");
		return lines.join("\n");
	}
	lines.push("", `<blockquote>${escapeTelegramHtml(preview(question.question, 800))}</blockquote>`);
	if (resolution?.outcome === "answered" && resolution.source === "remote" && answer) {
		lines.push(`<b>Answer</b>  ${escapeTelegramHtml(preview(answer, 1_200))}`);
	} else if (resolution?.outcome === "cancelled") {
		lines.push("No answer was submitted.");
	}
	return lines.join("\n");
}

class MaskedInput extends Input {
	override render(width: number): string[] {
		const runtime = this as unknown as { value: string };
		const value = runtime.value;
		runtime.value = "•".repeat(value.length);
		try {
			return super.render(width);
		} finally {
			runtime.value = value;
		}
	}
}

class SecretPrompt implements Component, Focusable {
	private readonly input = new MaskedInput();
	private _focused = false;

	constructor(
		private readonly label: string,
		private readonly tui: TUI,
		private readonly theme: any,
		private readonly done: (value: string | undefined) => void,
	) {
		this.input.onSubmit = (value) => this.done(value);
		this.input.onEscape = () => this.done(undefined);
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const max = Math.max(1, width);
		return [
			...wrapTextWithAnsi(this.label, max),
			...this.input.render(max),
			...wrapTextWithAnsi(this.theme.fg("dim", "Input is masked · Enter submit · Esc cancel"), max),
		];
	}

	invalidate(): void { this.input.invalidate(); }
}

async function secretInput(label: string, ctx: any): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui: TUI, theme: any, _keybindings: any, done: (value: string | undefined) => void) =>
		new SecretPrompt(label, tui, theme, done));
}

export function createTelegramNotificationsExtension(dependencies: RuntimeDependencies = {}) {
	const readConfig = dependencies.loadConfig ?? loadTelegramConfig;
	const writeConfig = dependencies.saveConfig ?? saveTelegramConfig;
	const sendMessage = dependencies.sendMessage ?? sendTelegramMessage;
	const sendRenderedMessage = dependencies.sendRenderedMessage ?? sendTelegramHtmlMessage;
	const sendQuestion = dependencies.sendQuestion ?? sendTelegramQuestion;
	const waitForAnswer = dependencies.waitForAnswer ?? waitForTelegramAnswer;
	const resolveQuestion = dependencies.resolveQuestion ?? resolveTelegramQuestion;
	const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));

	return function telegramNotifications(pi: ExtensionAPI) {
		interface PendingQuestion {
			requestId: string;
			question: WaitingQuestion;
			config: TelegramConfig;
			project: string;
			timer?: ReturnType<typeof setTimeout>;
			controller?: AbortController;
			sent?: SentTelegramQuestion;
			remoteAnswer?: string;
			resolution?: { outcome: "answered" | "cancelled"; source: "tui" | "remote" };
			finalized?: boolean;
		}

		let config = readConfig();
		let activeCtx: any;
		let pending: PendingQuestion | undefined;

		const finalizePending = (question: PendingQuestion) => {
			if (!question.sent || question.finalized) return;
			question.finalized = true;
			const text = formatResolvedMessage(question.project, question.question, question.resolution, question.remoteAnswer);
			void resolveQuestion(question.config, question.sent, text).catch(() => {});
		};

		const clearPending = (
			requestId?: string,
			resolution?: { outcome: "answered" | "cancelled"; source: "tui" | "remote" },
		) => {
			if (!pending || (requestId && pending.requestId !== requestId)) return;
			const cleared = pending;
			pending = undefined;
			cleared.resolution = resolution;
			if (cleared.timer) clearTimer(cleared.timer);
			cleared.controller?.abort();
			finalizePending(cleared);
		};

		const stopWaitingListener = pi.events.on(QUESTION_WAITING_EVENT, (event: unknown) => {
			const question = parseWaitingQuestion(event);
			if (!question || !activeCtx) return;
			clearPending();
			if (!config?.enabled) return;
			const snapshot = { ...config };
			const ctx = activeCtx;
			const project = contextLabel(pi, ctx.cwd);
			const current: PendingQuestion = { requestId: question.requestId, question, config: snapshot, project };
			pending = current;
			current.timer = setTimer(() => {
				current.timer = undefined;
				if (pending !== current) return;
				const controller = new AbortController();
				current.controller = controller;
				void (async () => {
					try {
						const text = formatWaitingMessage(project, question, snapshot.delayMinutes);
						if (question.secret) {
							current.sent = await sendRenderedMessage(snapshot, text, controller.signal);
							if (pending !== current) finalizePending(current);
							return;
						}
						const sent = await sendQuestion(snapshot, text, question, controller.signal);
						current.sent = sent;
						if (pending !== current) {
							finalizePending(current);
							return;
						}
						const answer = await waitForAnswer(snapshot, sent, question, controller.signal);
						if (pending === current) {
							current.remoteAnswer = answer;
							pi.events.emit(QUESTION_ANSWER_EVENT, { requestId: question.requestId, answer });
						}
					} catch (error) {
						if (!controller.signal.aborted) ctx.ui.notify(`Telegram notification failed: ${safeError(error)}`, "error");
					} finally {
						if (current.controller === controller) current.controller = undefined;
					}
				})();
			}, snapshot.delayMinutes * 60_000);
			current.timer.unref?.();
		});

		const stopResolvedListener = pi.events.on(QUESTION_RESOLVED_EVENT, (event: unknown) => {
			if (!event || typeof event !== "object") return;
			const value = event as { requestId?: unknown; outcome?: unknown; source?: unknown };
			if (typeof value.requestId !== "string") return;
			const outcome = value.outcome === "answered" || value.outcome === "cancelled" ? value.outcome : undefined;
			const source = value.source === "tui" || value.source === "remote" ? value.source : undefined;
			clearPending(value.requestId, outcome && source ? { outcome, source } : undefined);
		});

		pi.registerCommand("telegram", {
			description: "Set up and control delayed Telegram question notifications",
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase() || "status";
				if (action === "status") {
					if (!config) {
						ctx.ui.notify("Telegram notifications are not configured. Run /telegram setup.", "info");
						return;
					}
					ctx.ui.notify(`Telegram notifications are ${config.enabled ? "on" : "off"} (${formatDelay(config.delayMinutes)} delay).`, "info");
					return;
				}
				if (action === "setup") {
					if (ctx.mode !== "tui") {
						ctx.ui.notify("Telegram setup requires interactive TUI mode.", "warning");
						return;
					}
					const botToken = (await secretInput("Telegram bot token", ctx))?.trim();
					if (!botToken) return;
					const chatId = (await ctx.ui.input("Telegram chat ID", config?.chatId || "e.g. 123456789"))?.trim();
					if (!chatId) return;
					const delayText = (await ctx.ui.input("Delay in minutes", String(config?.delayMinutes ?? DEFAULT_DELAY_MINUTES)))?.trim();
					if (!delayText) return;
					const delayMinutes = Number(delayText);
					if (!Number.isFinite(delayMinutes) || delayMinutes <= 0 || delayMinutes > MAX_DELAY_MINUTES) {
						ctx.ui.notify(`Delay must be between 0 and ${MAX_DELAY_MINUTES} minutes.`, "warning");
						return;
					}
					const candidate: TelegramConfig = { botToken, chatId, delayMinutes, enabled: true };
					try {
						const project = contextLabel(pi, ctx.cwd);
						await sendMessage(candidate, `${project}: Telegram notifications configured.`);
						await writeConfig(candidate);
						config = candidate;
						ctx.ui.notify("Telegram notifications configured; test message sent.", "info");
					} catch (error) {
						ctx.ui.notify(`Telegram setup failed: ${safeError(error)}`, "error");
					}
					return;
				}
				if (!config) {
					ctx.ui.notify("Run /telegram setup first.", "warning");
					return;
				}
				if (action === "test") {
					try {
						const project = contextLabel(pi, ctx.cwd);
						await sendMessage(config, `${project}: Telegram notification test.`);
						ctx.ui.notify("Telegram test message sent.", "info");
					} catch (error) {
						ctx.ui.notify(`Telegram test failed: ${safeError(error)}`, "error");
					}
					return;
				}
				if (action !== "on" && action !== "off") {
					ctx.ui.notify("Usage: /telegram setup|on|off|status|test", "warning");
					return;
				}
				config = { ...config, enabled: action === "on" };
				await writeConfig(config);
				if (!config.enabled) clearPending();
				ctx.ui.notify(`Telegram notifications ${config.enabled ? "enabled" : "disabled"}.`, "info");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			clearPending();
			config = readConfig();
			activeCtx = ctx;
		});
		pi.on("session_shutdown", () => {
			clearPending();
			activeCtx = undefined;
			stopWaitingListener();
			stopResolvedListener();
		});
	};
}

export default createTelegramNotificationsExtension();
