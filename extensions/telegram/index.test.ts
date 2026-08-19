import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTelegramExtension,
	formatResolvedMessage,
	formatWaitingMessage,
	loadTelegramConfig,
	saveTelegramConfig,
	sendTelegramMessage,
	telegramConfigPath,
	type TelegramConfig,
} from "./index";

const temporaryDirectories: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;
const config: TelegramConfig = {
	botToken: "123456:test-token",
	chatId: "987654321",
	delayMinutes: 5,
	enabled: true,
};

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-telegram-agent-test-"));
	temporaryDirectories.push(agentDirectory);
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createScheduler() {
	let nextId = 0;
	const timers = new Map<number, { callback: () => void; delayMs: number }>();
	return {
		timers,
		setTimer(callback: () => void, delayMs: number) {
			const id = ++nextId;
			timers.set(id, { callback, delayMs });
			return id as any;
		},
		clearTimer(timer: ReturnType<typeof setTimeout>) {
			timers.delete(timer as any);
		},
		fire(id: number) {
			const timer = timers.get(id);
			if (!timer) return;
			timers.delete(id);
			timer.callback();
		},
	};
}

function makeHarness(options: {
	config?: TelegramConfig;
	sessionName?: string;
	sendMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendRenderedMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<{ chatId: string; messageId: number }>;
	sendQuestion?: (config: TelegramConfig, text: string, question: any, signal?: AbortSignal) => Promise<{ chatId: string; messageId: number }>;
	waitForAnswer?: (config: TelegramConfig, sent: any, question: any, signal: AbortSignal) => Promise<string>;
	resolveQuestion?: (config: TelegramConfig, sent: any, text: string) => Promise<void>;
} = {}) {
	const lifecycleHandlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const busHandlers: Record<string, Array<(event: any) => void>> = {};
	const scheduler = createScheduler();
	const sent: string[] = [];
	const notices: string[] = [];
	const emitted: Array<{ name: string; payload: unknown }> = [];
	const resolved: string[] = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const ctx = {
		cwd: "/tmp/example-project",
		mode: "tui",
		ui: { notify: (message: string) => notices.push(message) },
	};
	const extension = createTelegramExtension({
		loadConfig: () => options.config ?? config,
		saveConfig: async () => {},
		sendMessage: options.sendMessage ?? (async (_config, text) => { sent.push(text); }),
		sendRenderedMessage: options.sendRenderedMessage ?? (async (_config, text) => { sent.push(text); return { chatId: "987654321", messageId: 42 }; }),
		sendQuestion: options.sendQuestion ?? (async (_config, text) => { sent.push(text); return { chatId: "987654321", messageId: 42 }; }),
		waitForAnswer: options.waitForAnswer ?? (async () => new Promise<string>(() => {})),
		resolveQuestion: options.resolveQuestion ?? (async (_config, _question, text) => { resolved.push(text); }),
		setTimer: scheduler.setTimer,
		clearTimer: scheduler.clearTimer,
	});
	extension({
		events: {
			on(name: string, handler: (event: any) => void) {
				(busHandlers[name] ??= []).push(handler);
				return () => {
					busHandlers[name] = (busHandlers[name] ?? []).filter((candidate) => candidate !== handler);
				};
			},
			emit(name: string, payload: unknown) {
				emitted.push({ name, payload });
				for (const handler of busHandlers[name] ?? []) handler(payload);
			},
		},
		on(name: string, handler: (event: any, ctx: any) => any) {
			(lifecycleHandlers[name] ??= []).push(handler);
		},
		getSessionName: () => options.sessionName,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);

	return {
		scheduler,
		sent,
		notices,
		emitted,
		resolved,
		tools,
		async invokeTool(name: string, params: unknown) {
			return tools.get(name).execute("tool-call", params, new AbortController().signal, undefined, ctx);
		},
		async invokeCommand(name: string, args: string) {
			return commands.get(name).handler(args, ctx);
		},
		emitBus(name: string, event: unknown) {
			for (const handler of busHandlers[name] ?? []) handler(event);
		},
		async emit(name: string, event: unknown = {}) {
			for (const handler of lifecycleHandlers[name] ?? []) await handler(event, ctx);
		},
	};
}

function waiting(requestId: string, question = "Deploy to production?") {
	return {
		requestId,
		questionnaireId: "questionnaire",
		question,
		options: ["staging", "production"],
		allowOther: false,
		index: 1,
		total: 1,
		secret: false,
	};
}

const renderTheme = {
	fg: (_name: string, text: string) => text,
};

function rendered(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width).map((line) => line
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/<[^>]+>/g, ""));
}

describe("question wait lifecycle", () => {
	test("sends once only after the configured deadline", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));

		expect(harness.sent).toEqual([]);
		expect([...harness.scheduler.timers.values()].map((timer) => timer.delayMs)).toEqual([300_000]);
		harness.scheduler.fire(1);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]).toContain("❓ <b>Input needed</b>");
		expect(harness.sent[0]).toContain("<b>example-project</b> · Question 1 of 1");
		expect(harness.sent[0]).toContain("<blockquote>Deploy to production?</blockquote>");
	});

	test("prefers the escaped session title over the cwd", async () => {
		const harness = makeHarness({ sessionName: "Release <v2>" });
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.scheduler.fire(1);

		expect(harness.sent[0]).toContain("<b>Release &lt;v2&gt;</b> · Question 1 of 1");
		expect(harness.sent[0]).not.toContain("example-project");
	});

	test("answering before the deadline suppresses the message", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.emitBus("questions:resolved", { requestId: "request-1" });

		expect(harness.scheduler.timers.size).toBe(0);
		harness.scheduler.fire(1);
		expect(harness.sent).toEqual([]);
	});

	test("sends later questions immediately after the questionnaire alert activates", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", { ...waiting("batch:0", "First?"), questionnaireId: "batch", index: 1, total: 2 });
		expect(harness.scheduler.timers.get(1)?.delayMs).toBe(300_000);
		harness.scheduler.fire(1);
		await Promise.resolve();

		harness.emitBus("questions:resolved", {
			requestId: "batch:0",
			questionnaireId: "batch",
			index: 1,
			total: 2,
			outcome: "answered",
			source: "remote",
		});
		harness.emitBus("questions:waiting", { ...waiting("batch:1", "Second?"), questionnaireId: "batch", index: 2, total: 2 });
		expect(harness.scheduler.timers.get(2)?.delayMs).toBe(0);
		harness.scheduler.fire(2);
		expect(harness.sent.at(-1)).toContain("Second?");

		harness.emitBus("questions:resolved", {
			requestId: "batch:1",
			questionnaireId: "batch",
			index: 2,
			total: 2,
			outcome: "answered",
			source: "remote",
		});
		harness.emitBus("questions:waiting", { ...waiting("next:0", "Next questionnaire?"), questionnaireId: "next" });
		expect(harness.scheduler.timers.get(3)?.delayMs).toBe(300_000);
	});

	test("a new question replaces the previous deadline", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1", "First?"));
		harness.emitBus("questions:waiting", { ...waiting("request-2", "Second?"), index: 2, total: 2 });

		expect([...harness.scheduler.timers.keys()]).toEqual([2]);
		harness.scheduler.fire(1);
		harness.scheduler.fire(2);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]).toContain("Second?");
	});

	test("emits a remote answer and renders the resolved message", async () => {
		const harness = makeHarness({ waitForAnswer: async () => "production" });
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.scheduler.fire(1);
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.emitted).toContainEqual({
			name: "questions:answer",
			payload: { requestId: "request-1", answer: "production" },
		});
		harness.emitBus("questions:resolved", { requestId: "request-1", questionnaireId: "questionnaire", index: 1, total: 1, outcome: "answered", source: "remote" });
		await Promise.resolve();
		expect(harness.resolved).toHaveLength(1);
		expect(harness.resolved[0]).toContain("✅ <b>Answered in Telegram</b>");
		expect(harness.resolved[0]).toContain("<b>Answer</b>  production");
	});

	test("finalizes a message that resolves while sending", async () => {
		let finishSend!: (sent: { chatId: string; messageId: number }) => void;
		const harness = makeHarness({
			sendQuestion: async () => {
				return new Promise((resolve) => { finishSend = resolve; });
			},
		});
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.scheduler.fire(1);
		await Promise.resolve();

		harness.emitBus("questions:resolved", { requestId: "request-1", questionnaireId: "questionnaire", index: 1, total: 1, outcome: "answered", source: "tui" });
		finishSend({ chatId: "987654321", messageId: 77 });
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.resolved).toHaveLength(1);
		expect(harness.resolved[0]).toContain("✅ <b>Answered in Pi</b>");
	});

	test("shutdown cancels an in-flight Telegram poll", async () => {
		let requestSignal: AbortSignal | undefined;
		const harness = makeHarness({
			waitForAnswer: async (_config, _sent, _question, signal) => {
				requestSignal = signal;
				await new Promise<string>(() => {});
			},
		});
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.scheduler.fire(1);
		await Promise.resolve();
		expect(requestSignal?.aborted).toBe(false);

		await harness.emit("session_shutdown");
		expect(requestSignal?.aborted).toBe(true);
	});

	test("keeps secret questions passive and never starts answer polling", async () => {
		let interactiveCalls = 0;
		const harness = makeHarness({
			sendQuestion: async () => { interactiveCalls += 1; throw new Error("should not send interactively"); },
			waitForAnswer: async () => { interactiveCalls += 1; return "forbidden"; },
		});
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", {
			...waiting("secret", "Paste the production API token"),
			options: [],
			secret: true,
		});
		harness.scheduler.fire(1);
		await Promise.resolve();

		expect(interactiveCalls).toBe(0);
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]).toContain("🔐 <b>Secret input needed</b>");
		expect(harness.sent[0]).not.toContain("production API token");

		harness.emitBus("questions:resolved", { requestId: "secret", questionnaireId: "questionnaire", index: 1, total: 1, outcome: "answered", source: "tui" });
		await Promise.resolve();
		expect(harness.resolved[0]).toContain("✅ <b>Answered securely in Pi</b>");
		expect(harness.resolved[0]).not.toContain("production API token");
	});

	test("redacts secret question text", () => {
		const message = formatWaitingMessage("project", {
			requestId: "secret",
			question: "Paste the production API token",
			options: [],
			allowOther: false,
			index: 1,
			total: 1,
			secret: true,
		}, 5);
		expect(message).toContain("🔐 <b>Secret input needed</b>");
		expect(message).not.toContain("production API token");
	});

	test("escapes dynamic HTML and renders short delays as seconds", () => {
		const question = {
			...waiting("escaped", "Deploy <prod> & notify?"),
			options: [],
			allowOther: true,
		};
		const pending = formatWaitingMessage("api<worker>", question, 10 / 60);
		const resolved = formatResolvedMessage("api<worker>", question, { outcome: "answered", source: "remote" }, "ship <now> & confirm");

		expect(pending).toContain("<b>api&lt;worker&gt;</b>");
		expect(pending).toContain("<blockquote>Deploy &lt;prod&gt; &amp; notify?</blockquote>");
		expect(pending).toContain("⏱ The agent has been waiting 10 seconds for your response.");
		expect(resolved).toContain("ship &lt;now&gt; &amp; confirm");
		expect(`${pending}\n${resolved}`).not.toContain("<prod>");
	});
});

describe("direct user messages", () => {
	test("sends free-form text verbatim", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		const message = "The requested crawl is complete.\nArtifacts are ready for review.";

		const result = await harness.invokeTool("notify_user", { message });

		expect(harness.sent).toEqual([message]);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Telegram message sent to the user." }],
			details: { status: "sent" },
		});
	});

	test("renders compact native-style call, success, and error blocks", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		const tool = harness.tools.get("notify_user");
		const args = { message: "The crawl is complete.\nArtifacts are ready." };

		expect(tool.renderShell).toBe("self");
		expect(rendered(tool.renderCall(args, renderTheme, { isPartial: true }))).toEqual([
			"• Sending Telegram message",
			"  └ The crawl is complete. Artifacts are ready.",
		]);
		expect(rendered(tool.renderResult(
			{ content: [{ type: "text", text: "Telegram message sent to the user." }], details: { status: "sent" } },
			{ isPartial: false, expanded: false },
			renderTheme,
			{ args, isError: false },
		))).toEqual([
			"• Sent Telegram message",
			"  └ The crawl is complete. Artifacts are ready.",
		]);
		expect(rendered(tool.renderResult(
			{ content: [{ type: "text", text: "Request timed out" }] },
			{ isPartial: false, expanded: false },
			renderTheme,
			{ args, isError: true },
		))).toEqual([
			"• Telegram message failed",
			"  └ Request timed out",
		]);

		const expanded = tool.renderResult(
			{ content: [{ type: "text", text: "Telegram message sent to the user." }], details: { status: "sent" } },
			{ isPartial: false, expanded: true },
			renderTheme,
			{ args, isError: false },
		).render(32);
		expect(expanded.every((line: string) => visibleWidth(line) <= 32)).toBe(true);
	});

	test("guides the agent toward explicit, timely, or sensitive updates", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		const tool = harness.tools.get("notify_user");
		const guidance = [tool.description, ...tool.promptGuidelines].join(" ");

		expect(guidance).toContain("explicitly");
		expect(guidance).toContain("time-sensitive");
		expect(guidance).toContain("important or sensitive");
		expect(guidance).toContain("questionnaire");
	});

	test("registers only for enabled Telegram configurations", async () => {
		const harness = makeHarness({ config: { ...config, enabled: false } });
		await harness.emit("session_start");
		expect(harness.tools.has("notify_user")).toBe(false);

		await harness.invokeCommand("telegram", "on");
		expect(harness.tools.has("notify_user")).toBe(true);
		await harness.invokeTool("notify_user", { message: "Work is complete." });
		expect(harness.sent).toEqual(["Work is complete."]);
	});

	test("rejects messages that exceed Telegram's bound", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		await expect(harness.invokeTool("notify_user", { message: "x".repeat(4_097) }))
			.rejects.toThrow("Telegram messages are limited to 4096 characters.");
		expect(harness.sent).toEqual([]);
	});

	test("redacts the bot token from delivery failures", async () => {
		const harness = makeHarness({
			sendMessage: async (credentials) => { throw new Error(`request failed for ${credentials.botToken}`); },
		});
		await harness.emit("session_start");

		const message = harness.invokeTool("notify_user", { message: "Work is complete." });
		await expect(message).rejects.toThrow("Telegram message failed: request failed for [redacted]");
		await expect(message).rejects.not.toThrow(config.botToken);
	});
});

describe("configuration and Telegram client", () => {
	test("uses the configured Pi agent directory by default", async () => {
		await saveTelegramConfig(config);

		expect(telegramConfigPath()).toBe(join(agentDirectory, "telegram-notifications.json"));
		expect(statSync(telegramConfigPath()).mode & 0o777).toBe(0o600);
		expect(loadTelegramConfig()).toEqual(config);
	});

	test("writes credential config with owner-only permissions", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-telegram-test-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "nested", "telegram-notifications.json");

		await saveTelegramConfig(config, path);

		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(loadTelegramConfig(path)).toEqual(config);
	});

	test("posts plain JSON to the Telegram Bot API", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		await sendTelegramMessage(config, "Question waiting", undefined, async (url, init) => {
			capturedUrl = String(url);
			capturedInit = init;
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		expect(capturedUrl).toBe("https://api.telegram.org/bot123456:test-token/sendMessage");
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({
			chat_id: "987654321",
			text: "Question waiting",
			link_preview_options: { is_disabled: true },
		});
	});

	test("reports bounded API errors without exposing the token", async () => {
		const promise = sendTelegramMessage(config, "Question waiting", undefined, async () =>
			new Response(JSON.stringify({ ok: false, description: `bad token ${config.botToken}` }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			}));

		await expect(promise).rejects.toThrow("Telegram API request failed (HTTP 400): bad token [redacted]");
		await expect(promise).rejects.not.toThrow(config.botToken);
	});

	test("does not expose the token from network exceptions", async () => {
		const promise = sendTelegramMessage(config, "Question waiting", undefined, async () => {
			throw new Error(`failed to fetch https://api.telegram.org/bot${config.botToken}/sendMessage`);
		});

		await expect(promise).rejects.toThrow("Telegram API network request failed.");
		await expect(promise).rejects.not.toThrow(config.botToken);
	});
});
