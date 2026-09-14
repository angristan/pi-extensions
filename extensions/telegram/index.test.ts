import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramMarkdownToHtml } from "./markdown";
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

async function flushAsyncWork(): Promise<void> {
	await Bun.sleep(0);
}

function makeHarness(options: {
	config?: TelegramConfig;
	sessionName?: string;
	sessionId?: string;
	entries?: any[];
	supportsTopics?: (config: TelegramConfig, signal?: AbortSignal) => Promise<boolean>;
	createTopic?: (config: TelegramConfig, name: string, signal?: AbortSignal) => Promise<{ messageThreadId: number; name: string }>;
	renameTopic?: (config: TelegramConfig, messageThreadId: number, name: string, signal?: AbortSignal) => Promise<void>;
	sendMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendMarkdownMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendRenderedMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<{ chatId: string; messageId: number }>;
	sendQuestion?: (config: TelegramConfig, text: string, question: any, signal?: AbortSignal) => Promise<{ chatId: string; messageId: number }>;
	waitForAnswer?: (config: TelegramConfig, sent: any, question: any, signal: AbortSignal) => Promise<string>;
	resolveQuestion?: (config: TelegramConfig, sent: any, text: string) => Promise<void>;
} = {}) {
	const lifecycleHandlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const busHandlers: Record<string, Array<(event: any) => void>> = {};
	const scheduler = createScheduler();
	const sent: string[] = [];
	const deliveries: Array<{ kind: string; text: string; messageThreadId?: number }> = [];
	const notices: string[] = [];
	const emitted: Array<{ name: string; payload: unknown }> = [];
	const resolved: string[] = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries = options.entries ?? [];
	let sessionName = options.sessionName;
	const ctx = {
		cwd: "/tmp/example-project",
		mode: "tui",
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-1",
			getBranch: () => entries,
		},
		ui: { notify: (message: string) => notices.push(message) },
	};
	const extension = createTelegramExtension({
		loadConfig: () => options.config ?? config,
		saveConfig: async () => {},
		supportsTopics: options.supportsTopics ?? (async () => false),
		createTopic: options.createTopic,
		renameTopic: options.renameTopic,
		sendMessage: options.sendMessage ?? (async (delivery, text) => {
			sent.push(text);
			deliveries.push({ kind: "plain", text, messageThreadId: (delivery as any).messageThreadId });
		}),
		sendMarkdownMessage: options.sendMarkdownMessage ?? (async (delivery, text) => {
			sent.push(text);
			deliveries.push({ kind: "markdown", text, messageThreadId: (delivery as any).messageThreadId });
		}),
		sendRenderedMessage: options.sendRenderedMessage ?? (async (delivery, text) => {
			sent.push(text);
			deliveries.push({ kind: "rendered", text, messageThreadId: (delivery as any).messageThreadId });
			return { chatId: "987654321", messageId: 42 };
		}),
		sendQuestion: options.sendQuestion ?? (async (delivery, text) => {
			sent.push(text);
			deliveries.push({ kind: "question", text, messageThreadId: (delivery as any).messageThreadId });
			return { chatId: "987654321", messageId: 42 };
		}),
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
		getSessionName: () => sessionName,
		appendEntry(customType: string, data: any) {
			entries.push({ type: "custom", id: `entry-${entries.length + 1}`, customType, data });
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);

	const invocationContext = () => ({ ...ctx });

	return {
		scheduler,
		sent,
		deliveries,
		entries,
		notices,
		emitted,
		resolved,
		tools,
		async invokeTool(name: string, params: unknown) {
			return tools.get(name).execute("tool-call", params, new AbortController().signal, undefined, invocationContext());
		},
		async invokeCommand(name: string, args: string) {
			return commands.get(name).handler(args, invocationContext());
		},
		emitBus(name: string, event: unknown) {
			for (const handler of busHandlers[name] ?? []) handler(event);
		},
		setSessionName(name: string | undefined) { sessionName = name; },
		async emit(name: string, event: unknown = {}) {
			for (const handler of lifecycleHandlers[name] ?? []) await handler(event, invocationContext());
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
	test("routes delayed questions through the session topic", async () => {
		const harness = makeHarness({
			sessionName: "Production rollout",
			supportsTopics: async () => true,
			createTopic: async (_config, name) => ({ messageThreadId: 61, name }),
		});
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-topic"));
		harness.scheduler.fire(1);
		await flushAsyncWork();

		expect(harness.deliveries[0]).toMatchObject({ kind: "question", messageThreadId: 61 });
		expect(harness.deliveries[0]?.text).toContain("<b>Production rollout</b> · Question 1 of 1");
	});

	test("sends once only after the configured deadline", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));

		expect(harness.sent).toEqual([]);
		expect([...harness.scheduler.timers.values()].map((timer) => timer.delayMs)).toEqual([300_000]);
		harness.scheduler.fire(1);
		await flushAsyncWork();
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
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();
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
		await flushAsyncWork();
		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]).toContain("Second?");
	});

	test("emits a remote answer and renders the resolved message", async () => {
		const harness = makeHarness({ waitForAnswer: async () => "production" });
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.scheduler.fire(1);
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();
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
		await flushAsyncWork();

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
	test("creates one persistent topic per session and tracks title changes", async () => {
		const createdNames: string[] = [];
		const renamed: Array<{ messageThreadId: number; name: string }> = [];
		const harness = makeHarness({
			sessionName: "Crawl monitoring",
			supportsTopics: async () => true,
			createTopic: async (_config, name) => {
				createdNames.push(name);
				return { messageThreadId: 73, name };
			},
			renameTopic: async (_config, messageThreadId, name) => { renamed.push({ messageThreadId, name }); },
		});
		await harness.emit("session_start");

		await harness.invokeTool("notify_user", { message: "First update." });
		await harness.invokeTool("notify_user", { message: "Second update." });

		expect(createdNames).toEqual(["Crawl monitoring"]);
		expect(harness.deliveries).toEqual([
			{ kind: "markdown", text: "First update.", messageThreadId: 73 },
			{ kind: "markdown", text: "Second update.", messageThreadId: 73 },
		]);
		expect(harness.entries).toHaveLength(1);
		expect(harness.entries[0]).toMatchObject({
			type: "custom",
			customType: "telegram-session-topic",
			data: { version: 1, sessionId: "session-1", messageThreadId: 73, name: "Crawl monitoring" },
		});

		harness.setSessionName("Crawl complete");
		await harness.emit("session_info_changed", { name: "Crawl complete" });
		expect(renamed).toEqual([{ messageThreadId: 73, name: "Crawl complete" }]);
		expect(harness.entries.at(-1)?.data.name).toBe("Crawl complete");
	});

	test("restores a session topic without another Telegram lookup", async () => {
		const entries: any[] = [];
		const first = makeHarness({
			entries,
			supportsTopics: async () => true,
			createTopic: async (_config, name) => ({ messageThreadId: 84, name }),
		});
		await first.emit("session_start");
		await first.invokeTool("notify_user", { message: "Initial update." });

		const resumed = makeHarness({
			entries,
			supportsTopics: async () => { throw new Error("must not inspect Telegram again"); },
			createTopic: async () => { throw new Error("must not create another topic"); },
		});
		await resumed.emit("session_start");
		await resumed.invokeTool("notify_user", { message: "Resumed update." });

		expect(resumed.deliveries).toEqual([
			{ kind: "markdown", text: "Resumed update.", messageThreadId: 84 },
		]);
		expect(JSON.stringify(entries)).not.toContain(config.botToken);
	});

	test("does not reuse an inherited topic in a different session", async () => {
		const entries: any[] = [];
		const original = makeHarness({
			entries,
			sessionId: "session-original",
			supportsTopics: async () => true,
			createTopic: async (_config, name) => ({ messageThreadId: 84, name }),
		});
		await original.emit("session_start");
		await original.invokeTool("notify_user", { message: "Original update." });

		const fork = makeHarness({
			entries,
			sessionId: "session-fork",
			supportsTopics: async () => true,
			createTopic: async (_config, name) => ({ messageThreadId: 85, name }),
		});
		await fork.emit("session_start");
		await fork.invokeTool("notify_user", { message: "Fork update." });

		expect(fork.deliveries[0]?.messageThreadId).toBe(85);
	});

	test("falls back to General when topic creation fails", async () => {
		const harness = makeHarness({
			sessionName: "Fallback session",
			supportsTopics: async () => true,
			createTopic: async () => { throw new Error("topics unavailable"); },
		});
		await harness.emit("session_start");
		await harness.invokeTool("notify_user", { message: "Work is complete." });

		expect(harness.deliveries).toEqual([
			{ kind: "markdown", text: "**Fallback session**\n\nWork is complete.", messageThreadId: undefined },
		]);
		expect(harness.notices).toContain("Telegram topic unavailable; using General: topics unavailable");
	});

	test("prefixes Markdown messages with the escaped session title", async () => {
		const harness = makeHarness({ sessionName: "Release *v2* [plan](https://example.com) <safe>" });
		await harness.emit("session_start");
		const message = "**Crawl complete.**\n[Artifacts](https://example.com) are ready for review.";

		const result = await harness.invokeTool("notify_user", { message });

		expect(harness.sent).toEqual([
			"**Release \\*v2\\* \\[plan\\]\\(https\\:\\/\\/example\\.com\\) \\<safe\\>**\n\n" + message,
		]);
		expect(telegramMarkdownToHtml(harness.sent[0]!)).toStartWith(
			"<b>Release *v2* [plan](https://example.com) &lt;safe&gt;</b>\n\n",
		);
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

		expect(tool.description).toContain("Markdown-formatted");
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
		expect(harness.sent).toEqual(["**example\\-project**\n\nWork is complete."]);
	});

	test("rejects message bodies that leave no room for the title", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		await expect(harness.invokeTool("notify_user", { message: "x".repeat(3_995) }))
			.rejects.toThrow("Telegram message bodies are limited to 3994 characters to reserve room for the General fallback title.");
		expect(harness.sent).toEqual([]);
	});

	test("redacts the bot token from delivery failures", async () => {
		const harness = makeHarness({
			sendMarkdownMessage: async (credentials) => { throw new Error(`request failed for ${credentials.botToken}`); },
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
