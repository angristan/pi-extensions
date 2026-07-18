import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createContextFork } from "./context";
import registerSubagents, { boundedText } from "./index";
import type { AgentClient, AgentClientOptions, RpcAgentEvent } from "./rpc";

function assistant(text: string, stopReason = "stop"): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
		stopReason,
		timestamp: Date.now(),
	};
}

class FakeClient implements AgentClient {
	readonly events = new Set<(event: RpcAgentEvent) => void>();
	readonly exits = new Set<(error: Error) => void>();
	readonly prompts: string[] = [];
	readonly steering: string[] = [];
	started = false;
	stopped = false;
	constructor(readonly options: AgentClientOptions) {}
	async start() { this.started = true; }
	async stop() { this.stopped = true; }
	async prompt(message: string) { this.prompts.push(message); }
	async steer(message: string) { this.steering.push(message); }
	async abort() {}
	onEvent(listener: (event: RpcAgentEvent) => void) { this.events.add(listener); return () => this.events.delete(listener); }
	onExit(listener: (error: Error) => void) { this.exits.add(listener); return () => this.exits.delete(listener); }
	getStderr() { return ""; }
	emit(event: RpcAgentEvent) { for (const listener of [...this.events]) listener(event); }
	complete(text: string, stopReason = "stop") {
		this.emit({ type: "message_end", message: assistant(text, stopReason) });
		this.emit({ type: "agent_settled" });
	}
}

interface Harness {
	tool: any;
	commands: Map<string, any>;
	handlers: Map<string, (...args: any[]) => any>;
	clients: FakeClient[];
	sentMessages: Array<{ message: any; options: any }>;
	statuses: Map<string, string | undefined>;
	ctx: any;
	parent: SessionManager;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
	}
});

function createHarness(options: { maxAgents?: number; withPendingToolCall?: boolean; firstTurn?: boolean; failClientCreation?: boolean } = {}): Harness {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const clients: FakeClient[] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const statuses = new Map<string, string | undefined>();
	const parent = SessionManager.inMemory(process.cwd());
	parent.appendModelChange("test-provider", "test-model");
	parent.appendThinkingLevelChange("medium");
	if (!options.firstTurn) {
		parent.appendMessage({ role: "user", content: "Original request", timestamp: Date.now() });
		parent.appendMessage(assistant("Original answer"));
	}
	if (options.withPendingToolCall) {
		parent.appendMessage({ role: "user", content: "Delegate this", timestamp: Date.now() });
		parent.appendMessage({
			...assistant(""),
			content: [{ type: "toolCall", id: "call-1", name: "agents", arguments: { action: "spawn", task: "Inspect context" } }],
			stopReason: "toolUse",
		});
	}
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "test-provider", id: "test-model" },
		sessionManager: parent,
		ui: {
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			notify() {},
			select: async () => undefined,
		},
	};
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		registerMessageRenderer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		getActiveTools() { return ["read", "grep", "agents"]; },
		getThinkingLevel() { return "medium"; },
		sendMessage(message: any, messageOptions: any) { sentMessages.push({ message, options: messageOptions }); },
	};
	registerSubagents(pi as any, {
		maxAgents: options.maxAgents,
		createClient(clientOptions) {
			if (options.failClientCreation) throw new Error("client factory failed");
			const client = new FakeClient(clientOptions);
			clients.push(client);
			return client;
		},
	});
	const harness = { tool: tools.get("agents"), commands, handlers, clients, sentMessages, statuses, ctx, parent };
	harnesses.push(harness);
	void handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return harness;
}

async function spawnAgent(harness: Harness, task = "Inspect the repository") {
	return harness.tool.execute("call", { action: "spawn", task }, undefined, undefined, harness.ctx);
}

describe("subagents", () => {
	test("exposes one generic lifecycle tool without role presets", () => {
		const harness = createHarness();
		expect(harness.tool).toBeDefined();
		expect(Object.keys(harness.tool.parameters.properties)).toEqual([
			"action", "task", "agent_id", "message", "agent_ids", "timeout_ms",
		]);
		expect(harness.tool.parameters.properties).not.toHaveProperty("agent_type");
		expect(harness.tool.parameters.properties).not.toHaveProperty("model");
		expect(harness.tool.description).toContain("inherit the current model");
	});

	test("spawns immediately, inherits runtime choices, and reports completion", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness);
		const client = harness.clients[0];
		expect(client.started).toBe(true);
		expect(client.prompts[0]).toContain("Task:\nInspect the repository");
		expect(client.options.env?.PI_SUBAGENT_CHILD).toBe("1");
		expect(client.options.args).toContain("test-provider/test-model");
		expect(client.options.args).toContain("medium");
		const toolsArg = client.options.args[client.options.args.indexOf("--tools") + 1];
		expect(toolsArg).toBe("read,grep");
		expect(started.details.agents[0].status).toBe("running");
		expect(harness.statuses.get("subagents")).toContain("1 subagent running");

		client.complete("Found the relevant files.\u001b]0;unsafe\u0007");
		await Bun.sleep(0);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.content).toContain("Found the relevant files.");
		expect(harness.sentMessages[0].message.content).not.toContain("\u001b");
		expect(harness.sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(harness.statuses.get("subagents")).toBeUndefined();
	});

	test("forks inherited context before the unresolved delegating tool call", async () => {
		const harness = createHarness({ withPendingToolCall: true });
		await spawnAgent(harness, "Inspect context");
		const args = harness.clients[0].options.args;
		const sessionPath = args[args.indexOf("--session") + 1];
		expect(existsSync(sessionPath)).toBe(true);
		const child = SessionManager.open(sessionPath);
		const messages = child.buildSessionContext().messages;
		expect(messages.some((message: any) => message.role === "user" && message.content === "Delegate this")).toBe(true);
		expect(messages.some((message: any) => message.role === "assistant" && message.content?.some?.((part: any) => part.type === "toolCall"))).toBe(false);
	});

	test("creates a usable context file for first-turn delegation", async () => {
		const harness = createHarness({ withPendingToolCall: true, firstTurn: true });
		await spawnAgent(harness, "Inspect first turn");
		const args = harness.clients[0].options.args;
		const sessionPath = args[args.indexOf("--session") + 1];
		expect(existsSync(sessionPath)).toBe(true);
		const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
		expect(messages.map((message: any) => message.role)).toEqual(["user"]);
		expect(messages[0].content).toBe("Delegate this");
	});

	test("rejects missing IDs instead of resolving them as empty prefixes", async () => {
		const harness = createHarness();
		await spawnAgent(harness);
		await expect(harness.tool.execute("send", { action: "send", message: "wrong target" }, undefined, undefined, harness.ctx)).rejects.toThrow("not found");
		await expect(harness.tool.execute("close", { action: "close" }, undefined, undefined, harness.ctx)).rejects.toThrow("not found");
		expect(harness.clients[0].steering).toHaveLength(0);
		expect(harness.clients[0].stopped).toBe(false);
	});

	test("removes the context fork when client setup fails", async () => {
		const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-subagent-")));
		const harness = createHarness({ failClientCreation: true });
		await expect(spawnAgent(harness)).rejects.toThrow("client factory failed");
		const after = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-subagent-")));
		expect(after).toEqual(before);
	});

	test("shares one cleanup operation across concurrent callers", async () => {
		const harness = createHarness();
		const fork = await createContextFork(harness.ctx);
		const first = fork.cleanup();
		const second = fork.cleanup();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(existsSync(fork.directory)).toBe(false);
	});

	test("waits for multiple agents and avoids duplicate completion messages", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "First task");
		const second = await spawnAgent(harness, "Second task");
		setTimeout(() => {
			harness.clients[0].complete("First result");
			harness.clients[1].complete("Second result");
		}, 5);
		const result = await harness.tool.execute("wait", {
			action: "wait",
			agent_ids: [first.details.agents[0].id, second.details.agents[0].id],
			timeout_ms: 1_000,
		}, undefined, undefined, harness.ctx);
		expect(result.content[0].text).toContain("First result");
		expect(result.content[0].text).toContain("Second result");
		expect(result.details.timedOut).toBe(false);
		expect(harness.sentMessages).toHaveLength(0);
	});

	test("steers a running agent and prompts an idle agent", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness);
		const id = started.details.agents[0].id;
		await harness.tool.execute("send-running", { action: "send", agent_id: id, message: "Focus on tests" }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].steering).toEqual(["Focus on tests"]);
		harness.clients[0].complete("Initial result");
		await harness.tool.execute("send-idle", { action: "send", agent_id: id, message: "Now inspect docs" }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].prompts.at(-1)).toBe("Now inspect docs");
	});

	test("enforces the open-agent limit until a child is closed", async () => {
		const harness = createHarness({ maxAgents: 2 });
		const first = await spawnAgent(harness, "First");
		await spawnAgent(harness, "Second");
		await expect(spawnAgent(harness, "Third")).rejects.toThrow("At most 2 subagents");
		await harness.tool.execute("close", { action: "close", agent_id: first.details.agents[0].id }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].stopped).toBe(true);
		await expect(spawnAgent(harness, "Third")).resolves.toBeDefined();
	});

	test("bounds aggregate model-visible output", () => {
		const result = boundedText("x".repeat(100_000), 2_000);
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2_000);
		expect(result).toContain("output omitted");
	});
});
