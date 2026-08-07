import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	resolveDiscordQuestion,
	sendDiscordEmbed,
	sendDiscordMessage,
	sendDiscordQuestion,
	waitForDiscordAnswer,
	type DiscordEmbed,
	type DiscordQuestion,
	type SentDiscordQuestion,
} from "./bot-api";

export { sendDiscordMessage } from "./bot-api";

const QUESTION_WAITING_EVENT = "questions:waiting";
const QUESTION_ANSWER_EVENT = "questions:answer";
const QUESTION_RESOLVED_EVENT = "questions:resolved";
const DEFAULT_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 7 * 24 * 60;

const COLOR_WAITING = 0xffca28;
const COLOR_SECRET = 0x9b59b6;
const COLOR_RESOLVED = 0x2ecc71;
const COLOR_CANCELLED = 0xe74c3c;

export interface DiscordConfig {
	botToken: string;
	channelId: string;
	delayMinutes: number;
	enabled: boolean;
}

export interface WaitingQuestion {
	requestId: string;
	questionnaireId: string;
	question: string;
	options: string[];
	allowOther: boolean;
	index: number;
	total: number;
	secret: boolean;
}

interface RuntimeDependencies {
	loadConfig?: () => DiscordConfig | undefined;
	saveConfig?: (config: DiscordConfig) => Promise<void>;
	sendMessage?: (config: DiscordConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendEmbeddedMessage?: (config: DiscordConfig, embed: DiscordEmbed, signal?: AbortSignal) => Promise<SentDiscordQuestion>;
	sendQuestion?: (config: DiscordConfig, embed: DiscordEmbed, question: DiscordQuestion, signal?: AbortSignal) => Promise<SentDiscordQuestion>;
	waitForAnswer?: (config: DiscordConfig, sent: SentDiscordQuestion, question: DiscordQuestion, signal: AbortSignal) => Promise<string>;
	resolveQuestion?: (config: DiscordConfig, sent: SentDiscordQuestion, embed: DiscordEmbed) => Promise<void>;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function discordConfigPath(): string {
	return join(getAgentDir(), "discord-notifications.json");
}

function normalizedConfig(value: unknown): DiscordConfig | undefined {
	if (!value || typeof value !== "object") return undefined;
	const config = value as Record<string, unknown>;
	const botToken = typeof config.botToken === "string" ? config.botToken.trim() : "";
	const channelId = typeof config.channelId === "string" ? config.channelId.trim() : "";
	const configuredDelay = typeof config.delayMinutes === "number" ? config.delayMinutes : DEFAULT_DELAY_MINUTES;
	if (!botToken || !channelId || !Number.isFinite(configuredDelay) || configuredDelay <= 0) return undefined;
	return {
		botToken,
		channelId,
		delayMinutes: Math.min(configuredDelay, MAX_DELAY_MINUTES),
		enabled: config.enabled !== false,
	};
}

export function loadDiscordConfig(path = discordConfigPath()): DiscordConfig | undefined {
	try {
		return normalizedConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

export async function saveDiscordConfig(config: DiscordConfig, path = discordConfigPath()): Promise<void> {
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
	const questionnaireId = typeof value.questionnaireId === "string"
		? value.questionnaireId
		: value.requestId.replace(/:\d+$/, "");
	return {
		requestId: value.requestId,
		questionnaireId,
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

export function escapeDiscordMarkdown(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/`/g, "\\`")
		.replace(/~/g, "\\~")
		.replace(/\|/g, "\\|")
		.replace(/>/g, "\\>");
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
	return `**${escapeDiscordMarkdown(preview(project, 100))}** · Question ${question.index} of ${question.total}`;
}

function waitingInstruction(question: WaitingQuestion): string {
	if (question.options.length === 0) return "Click **Reply** and type your answer.";
	return question.allowOther ? "Choose an answer below, or type another one." : "Choose an answer below.";
}

export function formatWaitingEmbed(project: string, question: WaitingQuestion, delayMinutes: number): DiscordEmbed {
	if (question.secret) {
		return {
			color: COLOR_SECRET,
			title: "🔐 Secret input needed",
			description: [
				messageContext(project, question),
				"",
				"A secret response is waiting in Pi.",
				"For your security, answer in the terminal.",
				"",
				`⏱ The agent has been waiting ${formatDelay(delayMinutes)} for your response.`,
			].join("\n"),
		};
	}
	return {
		color: COLOR_WAITING,
		title: "❓ Input needed",
		description: [
			messageContext(project, question),
			"",
			`> ${escapeDiscordMarkdown(preview(question.question, 800))}`,
			`⏱ The agent has been waiting ${formatDelay(delayMinutes)} for your response.`,
			"",
			waitingInstruction(question),
		].join("\n"),
	};
}

export function formatResolvedEmbed(
	project: string,
	question: WaitingQuestion,
	resolution?: { outcome: "answered" | "cancelled"; source: "tui" | "remote" },
	answer?: string,
): DiscordEmbed {
	const cancelled = resolution?.outcome === "cancelled";
	const heading = !resolution
		? "⚪ Question closed"
		: cancelled
			? "⚪ Question cancelled in Pi"
			: question.secret
				? "✅ Answered securely in Pi"
				: resolution.source === "remote"
					? "✅ Answered in Discord"
					: "✅ Answered in Pi";
	const lines = [heading, messageContext(project, question)];
	if (question.secret) {
		if (cancelled) lines.push("", "No answer was submitted.");
		return { color: cancelled ? COLOR_CANCELLED : COLOR_RESOLVED, title: heading, description: lines.join("\n") };
	}
	lines.push("", `> ${escapeDiscordMarkdown(preview(question.question, 800))}`);
	if (resolution?.outcome === "answered" && resolution.source === "remote" && answer) {
		lines.push("", `**Answer**  ${escapeDiscordMarkdown(preview(answer, 1_200))}`);
	} else if (cancelled) {
		lines.push("", "No answer was submitted.");
	}
	return { color: cancelled ? COLOR_CANCELLED : COLOR_RESOLVED, title: heading, description: lines.join("\n") };
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

export function createDiscordNotificationsExtension(dependencies: RuntimeDependencies = {}) {
	const readConfig = dependencies.loadConfig ?? loadDiscordConfig;
	const writeConfig = dependencies.saveConfig ?? saveDiscordConfig;
	const sendMessage = dependencies.sendMessage ?? sendDiscordMessage;
	const sendEmbeddedMessage = dependencies.sendEmbeddedMessage ?? sendDiscordEmbed;
	const sendQuestion = dependencies.sendQuestion ?? sendDiscordQuestion;
	const waitForAnswer = dependencies.waitForAnswer ?? waitForDiscordAnswer;
	const resolveQuestion = dependencies.resolveQuestion ?? resolveDiscordQuestion;
	const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));

	return function discordNotifications(pi: ExtensionAPI) {
		interface PendingQuestion {
			requestId: string;
			question: WaitingQuestion;
			config: DiscordConfig;
			project: string;
			timer?: ReturnType<typeof setTimeout>;
			controller?: AbortController;
			sent?: SentDiscordQuestion;
			remoteAnswer?: string;
			resolution?: { outcome: "answered" | "cancelled"; source: "tui" | "remote" };
			finalized?: boolean;
		}

		let config = readConfig();
		let activeCtx: any;
		let pending: PendingQuestion | undefined;
		let activatedQuestionnaireId: string | undefined;

		const finalizePending = (question: PendingQuestion) => {
			if (!question.sent || question.finalized) return;
			question.finalized = true;
			const embed = formatResolvedEmbed(question.project, question.question, question.resolution, question.remoteAnswer);
			void resolveQuestion(question.config, question.sent, embed).catch(() => {});
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
			const delayMs = activatedQuestionnaireId === question.questionnaireId
				? 0
				: snapshot.delayMinutes * 60_000;
			current.timer = setTimer(() => {
				current.timer = undefined;
				if (pending !== current) return;
				const controller = new AbortController();
				current.controller = controller;
				void (async () => {
					try {
						const embed = formatWaitingEmbed(project, question, snapshot.delayMinutes);
						if (question.secret) {
							current.sent = await sendEmbeddedMessage(snapshot, embed, controller.signal);
							if (pending !== current) finalizePending(current);
							else activatedQuestionnaireId = question.questionnaireId;
							return;
						}
						const sent = await sendQuestion(snapshot, embed, question, controller.signal);
						current.sent = sent;
						if (pending !== current) {
							finalizePending(current);
							return;
						}
						activatedQuestionnaireId = question.questionnaireId;
						const answer = await waitForAnswer(snapshot, sent, question, controller.signal);
						if (pending === current) {
							current.remoteAnswer = answer;
							pi.events.emit(QUESTION_ANSWER_EVENT, { requestId: question.requestId, answer });
						}
					} catch (error) {
						if (!controller.signal.aborted) ctx.ui.notify(`Discord notification failed: ${safeError(error)}`, "error");
					} finally {
						if (current.controller === controller) current.controller = undefined;
					}
				})();
			}, delayMs);
			current.timer.unref?.();
		});

		const stopResolvedListener = pi.events.on(QUESTION_RESOLVED_EVENT, (event: unknown) => {
			if (!event || typeof event !== "object") return;
			const value = event as { requestId?: unknown; questionnaireId?: unknown; index?: unknown; total?: unknown; outcome?: unknown; source?: unknown };
			if (typeof value.requestId !== "string") return;
			const outcome = value.outcome === "answered" || value.outcome === "cancelled" ? value.outcome : undefined;
			const source = value.source === "tui" || value.source === "remote" ? value.source : undefined;
			clearPending(value.requestId, outcome && source ? { outcome, source } : undefined);
			const questionnaireId = typeof value.questionnaireId === "string" ? value.questionnaireId : undefined;
			const isLastQuestion = Number.isInteger(value.index) && Number.isInteger(value.total) && value.index === value.total;
			if (questionnaireId === activatedQuestionnaireId && (outcome === "cancelled" || isLastQuestion)) {
				activatedQuestionnaireId = undefined;
			}
		});

		pi.registerCommand("discord", {
			description: "Set up and control delayed Discord question notifications",
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase() || "status";
				if (action === "status") {
					if (!config) {
						ctx.ui.notify("Discord notifications are not configured. Run /discord setup.", "info");
						return;
					}
					ctx.ui.notify(`Discord notifications are ${config.enabled ? "on" : "off"} (${formatDelay(config.delayMinutes)} delay).`, "info");
					return;
				}
				if (action === "setup") {
					if (ctx.mode !== "tui") {
						ctx.ui.notify("Discord setup requires interactive TUI mode.", "warning");
						return;
					}
					const botToken = (await secretInput("Discord bot token", ctx))?.trim();
					if (!botToken) return;
					const channelId = (await ctx.ui.input("Discord channel ID", config?.channelId || "e.g. 123456789012345678"))?.trim();
					if (!channelId) return;
					const delayText = (await ctx.ui.input("Delay in minutes", String(config?.delayMinutes ?? DEFAULT_DELAY_MINUTES)))?.trim();
					if (!delayText) return;
					const delayMinutes = Number(delayText);
					if (!Number.isFinite(delayMinutes) || delayMinutes <= 0 || delayMinutes > MAX_DELAY_MINUTES) {
						ctx.ui.notify(`Delay must be between 0 and ${MAX_DELAY_MINUTES} minutes.`, "warning");
						return;
					}
					const candidate: DiscordConfig = { botToken, channelId, delayMinutes, enabled: true };
					try {
						const project = contextLabel(pi, ctx.cwd);
						await sendMessage(candidate, `${project}: Discord notifications configured.`);
						await writeConfig(candidate);
						config = candidate;
						ctx.ui.notify("Discord notifications configured; test message sent.", "info");
					} catch (error) {
						ctx.ui.notify(`Discord setup failed: ${safeError(error)}`, "error");
					}
					return;
				}
				if (!config) {
					ctx.ui.notify("Run /discord setup first.", "warning");
					return;
				}
				if (action === "test") {
					try {
						const project = contextLabel(pi, ctx.cwd);
						await sendMessage(config, `${project}: Discord notification test.`);
						ctx.ui.notify("Discord test message sent.", "info");
					} catch (error) {
						ctx.ui.notify(`Discord test failed: ${safeError(error)}`, "error");
					}
					return;
				}
				if (action !== "on" && action !== "off") {
					ctx.ui.notify("Usage: /discord setup|on|off|status|test", "warning");
					return;
				}
				config = { ...config, enabled: action === "on" };
				await writeConfig(config);
				if (!config.enabled) clearPending();
				ctx.ui.notify(`Discord notifications ${config.enabled ? "enabled" : "disabled"}.`, "info");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			clearPending();
			activatedQuestionnaireId = undefined;
			config = readConfig();
			activeCtx = ctx;
		});
		pi.on("session_shutdown", () => {
			clearPending();
			activatedQuestionnaireId = undefined;
			activeCtx = undefined;
			stopWaitingListener();
			stopResolvedListener();
		});
	};
}

export default createDiscordNotificationsExtension();
