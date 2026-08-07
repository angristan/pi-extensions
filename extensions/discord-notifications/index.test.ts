import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDiscordNotificationsExtension,
	discordConfigPath,
	formatResolvedEmbed,
	formatWaitingEmbed,
	loadDiscordConfig,
	saveDiscordConfig,
	sendDiscordMessage,
	type DiscordConfig,
	type DiscordEmbed,
} from "./index";

const temporaryDirectories: string[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;
const config: DiscordConfig = {
	botToken: "test-token",
	channelId: "987654321",
	delayMinutes: 5,
	enabled: true,
};

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-discord-agent-test-"));
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
	config?: DiscordConfig;
	sessionName?: string;
	sendMessage?: (config: DiscordConfig, text: string, signal?: AbortSignal) => Promise<void>;
	sendEmbeddedMessage?: (config: DiscordConfig, embed: DiscordEmbed, signal?: AbortSignal) => Promise<{ channelId: string; messageId: string }>;
	sendQuestion?: (config: DiscordConfig, embed: DiscordEmbed, question: any, signal?: AbortSignal) => Promise<{ channelId: string; messageId: string }>;
	waitForAnswer?: (config: DiscordConfig, sent: any, question: any, signal: AbortSignal) => Promise<string>;
	resolveQuestion?: (config: DiscordConfig, sent: any, embed: DiscordEmbed) => Promise<void>;
} = {}) {
	const lifecycleHandlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const busHandlers: Record<string, Array<(event: any) => void>> = {};
	const scheduler = createScheduler();
	const sent: Array<string | DiscordEmbed> = [];
	const notices: string[] = [];
	const emitted: Array<{ name: string; payload: unknown }> = [];
	const resolved: DiscordEmbed[] = [];
	const ctx = {
		cwd: "/tmp/example-project",
		mode: "tui",
		ui: { notify: (message: string) => notices.push(message) },
	};
	const identity = { channelId: "987654321", messageId: "42" };
	const extension = createDiscordNotificationsExtension({
		loadConfig: () => options.config ?? config,
		saveConfig: async () => {},
		sendMessage: options.sendMessage ?? (async (_config, text) => { sent.push(text); }),
		sendEmbeddedMessage: options.sendEmbeddedMessage ?? (async (_config, embed) => { sent.push(embed); return identity; }),
		sendQuestion: options.sendQuestion ?? (async (_config, embed) => { sent.push(embed); return identity; }),
		waitForAnswer: options.waitForAnswer ?? (async () => new Promise<string>(() => {})),
		resolveQuestion: options.resolveQuestion ?? (async (_config, _question, embed) => { resolved.push(embed); }),
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
		registerCommand() {},
	} as any);

	return {
		scheduler,
		sent,
		notices,
		emitted,
		resolved,
		firstEmbed() {
			return sent.find((entry) => typeof entry === "object") as DiscordEmbed;
		},
		lastEmbed() {
			const objects = sent.filter((entry) => typeof entry === "object");
			return objects[objects.length - 1] as DiscordEmbed;
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

describe("question wait lifecycle", () => {
	test("sends once only after the configured deadline", async () => {
		const harness = makeHarness();
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));

		expect(harness.sent).toEqual([]);
		expect([...harness.scheduler.timers.values()].map((timer) => timer.delayMs)).toEqual([300_000]);
		harness.scheduler.fire(1);
		expect(harness.sent).toHaveLength(1);
		const embed = harness.firstEmbed();
		expect(embed.title).toBe("❓ Input needed");
		expect(embed.description).toContain("**example-project** · Question 1 of 1");
		expect(embed.description).toContain("Deploy to production?");
		expect(embed.description).toContain("5 minutes");
	});

	test("prefers the session title over the cwd", async () => {
		const harness = makeHarness({ sessionName: "Release <v2>" });
		await harness.emit("session_start");
		harness.emitBus("questions:waiting", waiting("request-1"));
		harness.scheduler.fire(1);

		const embed = harness.firstEmbed();
		expect(embed.description).toContain("**Release <v2\\>** · Question 1 of 1");
		expect(embed.description).not.toContain("example-project");
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
		expect(harness.lastEmbed().description).toContain("Second?");

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
		expect(harness.firstEmbed().description).toContain("Second?");
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
		expect(harness.resolved[0].title).toBe("✅ Answered in Discord");
		expect(harness.resolved[0].description).toContain("**Answer**  production");
	});

	test("finalizes a message that resolves while sending", async () => {
		let finishSend!: (sent: { channelId: string; messageId: string }) => void;
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
		finishSend({ channelId: "987654321", messageId: "77" });
		await Promise.resolve();
		await Promise.resolve();

		expect(harness.resolved).toHaveLength(1);
		expect(harness.resolved[0].title).toBe("✅ Answered in Pi");
	});

	test("shutdown cancels an in-flight Discord poll", async () => {
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
		const embed = harness.firstEmbed();
		expect(embed.title).toBe("🔐 Secret input needed");
		expect(embed.description).not.toContain("production API token");

		harness.emitBus("questions:resolved", { requestId: "secret", questionnaireId: "questionnaire", index: 1, total: 1, outcome: "answered", source: "tui" });
		await Promise.resolve();
		expect(harness.resolved[0].title).toBe("✅ Answered securely in Pi");
		expect(harness.resolved[0].description).not.toContain("production API token");
	});

	test("redacts secret question text", () => {
		const embed = formatWaitingEmbed("project", {
			requestId: "secret",
			question: "Paste the production API token",
			options: [],
			allowOther: false,
			index: 1,
			total: 1,
			secret: true,
		}, 5);
		expect(embed.title).toBe("🔐 Secret input needed");
		expect(embed.description).not.toContain("production API token");
	});

	test("escapes dynamic markdown and renders short delays as seconds", () => {
		const question = {
			...waiting("escaped", "Pick *the* | best & target"),
			options: [],
			allowOther: true,
		};
		const pending = formatWaitingEmbed("api<worker>", question, 10 / 60);
		const resolved = formatResolvedEmbed("api<worker>", question, { outcome: "answered", source: "remote" }, "ship *now*");

		expect(pending.description).toContain("**api<worker\\>**");
		expect(pending.description).toContain("Pick \\*the\\* \\| best & target");
		expect(pending.description).toContain("10 seconds");
		expect(resolved.description).toContain("ship \\*now\\*");
		expect(`${pending.description}\n${resolved.description}`).not.toContain("*the*");
	});
});

describe("configuration and Discord client", () => {
	test("uses the configured Pi agent directory by default", async () => {
		await saveDiscordConfig(config);

		expect(discordConfigPath()).toBe(join(agentDirectory, "discord-notifications.json"));
		expect(statSync(discordConfigPath()).mode & 0o777).toBe(0o600);
		expect(loadDiscordConfig()).toEqual(config);
	});

	test("writes credential config with owner-only permissions", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-discord-test-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "nested", "discord-notifications.json");

		await saveDiscordConfig(config, path);

		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(loadDiscordConfig(path)).toEqual(config);
	});

	test("posts plain JSON to the Discord API with a bot authorization header", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		await sendDiscordMessage(config, "Question waiting", undefined, async (url, init) => {
			capturedUrl = String(url);
			capturedInit = init;
			return new Response(JSON.stringify({ id: "1" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		expect(capturedUrl).toBe("https://discord.com/api/v10/channels/987654321/messages");
		expect(capturedInit?.method).toBe("POST");
		expect((capturedInit?.headers as Record<string, string>)["Authorization"]).toBe("Bot test-token");
		expect(JSON.parse(String(capturedInit?.body))).toEqual({ content: "Question waiting", allowed_mentions: { parse: [] } });
	});
});