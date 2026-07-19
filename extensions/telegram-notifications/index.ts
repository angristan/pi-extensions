import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const QUESTION_WAITING_EVENT = "questions:waiting";
const QUESTION_RESOLVED_EVENT = "questions:resolved";
const DEFAULT_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 7 * 24 * 60;
const REQUEST_TIMEOUT_MS = 15_000;

export interface TelegramConfig {
	botToken: string;
	chatId: string;
	delayMinutes: number;
	enabled: boolean;
}

export interface WaitingQuestion {
	requestId: string;
	question: string;
	index: number;
	total: number;
	secret: boolean;
}

interface RuntimeDependencies {
	loadConfig?: () => TelegramConfig | undefined;
	saveConfig?: (config: TelegramConfig) => Promise<void>;
	sendMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<void>;
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

export async function sendTelegramMessage(
	config: Pick<TelegramConfig, "botToken" | "chatId">,
	text: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	if (!/^[^/?#\s]+$/.test(config.botToken)) throw new Error("Telegram bot token has an invalid format.");
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	let response: Response;
	try {
		response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: config.chatId, text }),
			signal: requestSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		const name = error instanceof Error ? error.name : "";
		throw new Error(name === "TimeoutError" || timeoutSignal.aborted
			? "Telegram API request timed out."
			: "Telegram API network request failed.");
	}
	let payload: { ok?: unknown; description?: unknown } | undefined;
	try {
		payload = await response.json() as { ok?: unknown; description?: unknown };
	} catch {
		// HTTP status still provides a useful bounded error below.
	}
	if (!response.ok || payload?.ok !== true) {
		const description = typeof payload?.description === "string"
			? `: ${payload.description.replaceAll(config.botToken, "[redacted]").replace(/\s+/g, " ").slice(0, 180)}`
			: "";
		throw new Error(`Telegram API request failed (HTTP ${response.status})${description}`);
	}
}

function parseWaitingQuestion(event: unknown): WaitingQuestion | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as Record<string, unknown>;
	if (typeof value.requestId !== "string" || typeof value.question !== "string") return undefined;
	if (!Number.isInteger(value.index) || !Number.isInteger(value.total)) return undefined;
	const index = value.index as number;
	const total = value.total as number;
	if (index < 1 || total < index) return undefined;
	return { requestId: value.requestId, question: value.question, index, total, secret: value.secret === true };
}

function formatMinutes(minutes: number): string {
	const value = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
	return `${value} minute${minutes === 1 ? "" : "s"}`;
}

function preview(value: string, limit: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function formatWaitingMessage(project: string, question: WaitingQuestion, delayMinutes: number): string {
	return [
		`❓ ${preview(project, 100)}: input needed`,
		`The agent has been waiting ${formatMinutes(delayMinutes)} for your answer.`,
		question.secret
			? `Question ${question.index}/${question.total}: Secret response requested.`
			: `Question ${question.index}/${question.total}: ${preview(question.question, 800)}`,
	].join("\n");
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
	const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));

	return function telegramNotifications(pi: ExtensionAPI) {
		let config = readConfig();
		let activeCtx: any;
		let pendingRequestId: string | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let requestController: AbortController | undefined;

		const clearPending = (requestId?: string) => {
			if (requestId && pendingRequestId !== requestId) return;
			if (timer) clearTimer(timer);
			timer = undefined;
			requestController?.abort();
			requestController = undefined;
			pendingRequestId = undefined;
		};

		const stopWaitingListener = pi.events.on(QUESTION_WAITING_EVENT, (event: unknown) => {
			const question = parseWaitingQuestion(event);
			if (!question || !activeCtx) return;
			clearPending();
			if (!config?.enabled) return;
			const snapshot = { ...config };
			const ctx = activeCtx;
			const project = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
			pendingRequestId = question.requestId;
			timer = setTimer(() => {
				timer = undefined;
				if (pendingRequestId !== question.requestId) return;
				const controller = new AbortController();
				requestController = controller;
				void sendMessage(snapshot, formatWaitingMessage(project, question, snapshot.delayMinutes), controller.signal)
					.catch((error) => {
						if (!controller.signal.aborted) ctx.ui.notify(`Telegram notification failed: ${safeError(error)}`, "error");
					})
					.finally(() => {
						if (requestController === controller) requestController = undefined;
						if (pendingRequestId === question.requestId) pendingRequestId = undefined;
					});
			}, snapshot.delayMinutes * 60_000);
			timer.unref?.();
		});

		const stopResolvedListener = pi.events.on(QUESTION_RESOLVED_EVENT, (event: unknown) => {
			if (!event || typeof event !== "object") return;
			const requestId = (event as { requestId?: unknown }).requestId;
			if (typeof requestId === "string") clearPending(requestId);
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
					ctx.ui.notify(`Telegram notifications are ${config.enabled ? "on" : "off"} (${formatMinutes(config.delayMinutes)} delay).`, "info");
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
						const project = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
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
						const project = ctx.cwd.split("/").filter(Boolean).pop() || "pi";
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
