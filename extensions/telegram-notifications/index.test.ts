import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTelegramNotificationsExtension,
	formatWaitingMessage,
	loadTelegramConfig,
	saveTelegramConfig,
	sendTelegramMessage,
	type TelegramConfig,
} from "./index";

const temporaryDirectories: string[] = [];
const config: TelegramConfig = {
	botToken: "123456:test-token",
	chatId: "987654321",
	delayMinutes: 5,
	enabled: true,
};

afterEach(() => {
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
	sendMessage?: (config: TelegramConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendQuestion?: (config: TelegramConfig, text: string, question: any, signal?: AbortSignal) => Promise<{ chatId: string; messageId: number }>;
	waitForAnswer?: (config: TelegramConfig, sent: any, question: any, signal: AbortSignal) => Promise<string>;
	dismissQuestion?: (config: TelegramConfig, sent: any) => Promise<void>;
} = {}) {
	const lifecycleHandlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const busHandlers: Record<string, Array<(event: any) => void>> = {};
	const scheduler = createScheduler();
	const sent: string[] = [];
	const notices: string[] = [];
	const emitted: Array<{ name: string; payload: unknown }> = [];
	const dismissed: number[] = [];
	const ctx = {
		cwd: "/tmp/example-project",
		mode: "tui",
		ui: { notify: (message: string) => notices.push(message) },
	};
	const extension = createTelegramNotificationsExtension({
		loadConfig: () => options.config ?? config,
		saveConfig: async () => {},
		sendMessage: options.sendMessage ?? (async (_config, text) => { sent.push(text); }),
		sendQuestion: options.sendQuestion ?? (async (_config, text) => { sent.push(text); return { chatId: "987654321", messageId: 42 }; }),
		waitForAnswer: options.waitForAnswer ?? (async () => new Promise<string>(() => {})),
		dismissQuestion: options.dismissQuestion ?? (async (_config, question) => { dismissed.push(question.messageId); }),
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
		registerCommand() {},
	} as any);

	return {
		scheduler,
		sent,
		notices,
		emitted,
		dismissed,
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
		question,
		options: ["staging", "production"],
		allowOther: false,
		index: 1,
		total: 1,
		secret: false,
	};
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
		expect(harness.sent[0]).toContain("example-project: input needed");
		expect(harness.sent[0]).toContain("Deploy to production?");
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

	test("emits a remote answer and dismisses buttons after resolution", async () => {
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
		harness.emitBus("questions:resolved", { requestId: "request-1" });
		await Promise.resolve();
		expect(harness.dismissed).toEqual([42]);
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
		expect(harness.sent[0]).toContain("Secret response requested");
		expect(harness.sent[0]).not.toContain("production API token");
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
		expect(message).toContain("Secret response requested");
		expect(message).not.toContain("production API token");
	});
});

describe("configuration and Telegram client", () => {
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
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ chat_id: "987654321", text: "Question waiting" });
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
