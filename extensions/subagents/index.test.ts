import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createContextFork, forkableMessages } from "./context";
import registerSubagents, { boundedText } from "./index";
import type { AgentClient, AgentClientOptions, RpcAgentEvent } from "./rpc";

interface OverlayRegistration {
	definition: any;
	invalidations: number;
	unregistered: boolean;
}

function assistant(text: string, stopReason = "stop", errorMessage?: string): any {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "test",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
		stopReason,
		errorMessage,
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
	stopError?: Error;
	promptError?: Error;
	steerError?: Error;
	constructor(readonly options: AgentClientOptions) {}
	async start() { this.started = true; }
	async stop() {
		if (this.stopError) throw this.stopError;
		this.stopped = true;
	}
	async prompt(message: string) {
		if (this.promptError) throw this.promptError;
		this.prompts.push(message);
	}
	async steer(message: string) {
		if (this.steerError) throw this.steerError;
		this.steering.push(message);
	}
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
	messageRenderers: Map<string, (...args: any[]) => any>;
	handlers: Map<string, (...args: any[]) => any>;
	clients: FakeClient[];
	sentMessages: Array<{ message: any; options: any }>;
	statuses: Map<string, string | undefined>;
	overlay: OverlayRegistration;
	ctx: any;
	parent: SessionManager;
}

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
	}
});

function createHarness(options: {
	maxAgents?: number;
	withPendingToolCall?: boolean;
	firstTurn?: boolean;
	failClientCreation?: boolean;
	forkContext?: typeof createContextFork;
} = {}): Harness {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messageRenderers = new Map<string, (...args: any[]) => any>();
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
		registerMessageRenderer(type: string, renderer: (...args: any[]) => any) { messageRenderers.set(type, renderer); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		getActiveTools() { return ["read", "grep", "agents"]; },
		getThinkingLevel() { return "medium"; },
		sendMessage(message: any, messageOptions: any) { sentMessages.push({ message, options: messageOptions }); },
	};
	let overlay: OverlayRegistration | undefined;
	registerSubagents(pi as any, {
		maxAgents: options.maxAgents,
		createContextFork: options.forkContext,
		registerOverlayCard(definition) {
			overlay = { definition, invalidations: 0, unregistered: false };
			return {
				invalidate() { overlay!.invalidations += 1; },
				unregister() { overlay!.unregistered = true; },
			};
		},
		createClient(clientOptions) {
			if (options.failClientCreation) throw new Error("client factory failed");
			const client = new FakeClient(clientOptions);
			clients.push(client);
			return client;
		},
	});
	if (!overlay) throw new Error("Subagents overlay was not registered");
	const harness = { tool: tools.get("agents"), commands, messageRenderers, handlers, clients, sentMessages, statuses, overlay, ctx, parent };
	harnesses.push(harness);
	void handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return harness;
}

async function spawnAgent(harness: Harness, task = "Inspect the repository") {
	return harness.tool.execute("call", { action: "spawn", task }, undefined, undefined, harness.ctx);
}

const renderTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function rendered(component: any, width = 100): string[] {
	return component.render(width).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("subagents", () => {
	test("exposes one generic lifecycle tool without role presets", () => {
		const harness = createHarness();
		expect(harness.tool).toBeDefined();
		expect(Object.keys(harness.tool.parameters.properties)).toEqual([
			"reasoning", "action", "task", "fork_context", "name", "agent_id", "message", "agent_ids", "timeout_ms",
		]);
		expect(harness.tool.parameters.required).toEqual(["reasoning", "action"]);
		expect(harness.tool.parameters.properties).not.toHaveProperty("agent_type");
		expect(harness.tool.parameters.properties).not.toHaveProperty("model");
		expect(harness.tool.parameters.properties.task.maxLength).toBe(16_000);
		expect(harness.tool.parameters.properties.message.maxLength).toBe(16_000);
		expect(harness.tool.description).toContain("inherit the current model");
		expect(harness.tool.parameters.properties.fork_context.description).toContain("default true");
		expect(harness.tool.parameters.properties.name).toMatchObject({ maxLength: 80, description: expect.stringContaining("human-readable") });
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("fork_context=false") && guideline.includes("defaults to true"))).toBe(true);
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("action=close") && guideline.includes("consume a process slot"))).toBe(true);
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

	test("shows active agents in the shared overlay and hides them after completion", async () => {
		const harness = createHarness();
		const card = harness.overlay.definition;
		expect({ id: card.id, order: card.order, width: card.width }).toEqual({ id: "subagents", order: 15, width: 58 });
		expect(card.visible()).toBe(false);

		const started = await spawnAgent(harness, "Inspect a very long repository task whose description must fit the overlay");
		const id = started.details.agents[0].id;
		expect(card.visible()).toBe(true);
		expect(card.title(renderTheme)).toContain("Agents ● 1 running");
		let body = card.renderBody(54, 6, renderTheme);
		expect(body).toHaveLength(3);
		expect(body[0]).toContain(id.slice(-7));
		expect(body[0]).toContain("0 tok");
		expect(body[1]).toContain("Inspect a very long repository task");
		expect(body[2]).toContain("working");
		expect(body.every((line: string) => visibleWidth(line) <= 54)).toBe(true);

		const invalidations = harness.overlay.invalidations;
		harness.clients[0].emit({ type: "tool_execution_start", toolName: "read", args: { path: "index.ts" } });
		expect(harness.overlay.invalidations).toBeGreaterThan(invalidations);
		body = card.renderBody(54, 6, renderTheme);
		expect(body[2]).toContain("read");

		harness.clients[0].emit({ type: "message_end", message: assistant("Inspection complete") });
		expect(card.renderBody(54, 6, renderTheme)[0]).toContain("20 tok");
		harness.clients[0].emit({ type: "agent_settled" });
		expect(card.visible()).toBe(false);
		expect(card.renderBody(54, 6, renderTheme)).toEqual([]);
		const listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents.find((agent: any) => agent.id === id)?.status).toBe("completed");
		expect(harness.clients[0].stopped).toBe(false);

		await harness.tool.execute("close", { action: "close", agent_id: id }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].stopped).toBe(true);
		await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
		expect(harness.overlay.unregistered).toBe(true);
		harnesses.splice(harnesses.indexOf(harness), 1);
	});

	test("bounds overlay rows and reports hidden open agents", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "First overlay task");
		await spawnAgent(harness, "Second overlay task");
		await spawnAgent(harness, "Third overlay task");
		const lines = harness.overlay.definition.renderBody(38, 4, renderTheme);
		expect(lines).toHaveLength(4);
		expect(lines[3]).toContain("… 2 more · /agents");
		expect(lines.every((line: string) => visibleWidth(line) <= 38)).toBe(true);
	});

	test("uses native-style partial and settled cards without duplicate rows", async () => {
		const harness = createHarness();
		const args = { reasoning: "Delegate repository inspection", action: "spawn", task: "Inspect the repository" };
		const call = harness.tool.renderCall(args, renderTheme, { isPartial: true, args });
		expect(rendered(call)).toEqual([
			"• Spawning agent Delegate repository inspection",
			"  └ Inspect the repository",
		]);
		expect(rendered(harness.tool.renderCall(args, renderTheme, { isPartial: false, args }))).toEqual([]);

		const result = await harness.tool.execute("spawn", args, undefined, undefined, harness.ctx);
		const settled = harness.tool.renderResult(result, { isPartial: false, expanded: false }, renderTheme, {
			lastComponent: call,
			args,
			isError: false,
		});
		expect(settled).toBe(call);
		const lines = rendered(settled);
		expect(lines[0]).toBe("• Spawned agent Delegate repository inspection");
		expect(lines[1]).toBe("  └ Inspect the repository");
		expect(lines[2]).toContain(`● ${result.details.agents[0].id} · forked context · running`);
		expect(lines.join("\n")).not.toMatch(/\b\d+ms\b/);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	test("renders wait timeouts, expanded results, and errors semantically", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "Inspect API");
		harness.clients[0].complete("API review complete.");
		const waitArgs = { reasoning: "Collect delegated review", action: "wait", agent_ids: [first.details.agents[0].id], timeout_ms: 1_000 };
		const waited = await harness.tool.execute("wait", waitArgs, undefined, undefined, harness.ctx);
		const collapsed = rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: false }, renderTheme, { args: waitArgs }));
		expect(collapsed[0]).toBe("• Waited for agents Collect delegated review");
		expect(collapsed.join("\n")).not.toContain("API review complete");
		const expanded = rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: true }, renderTheme, { args: waitArgs }), 60);
		expect(expanded.join("\n")).toContain("API review complete.");
		expect(expanded.join("\n")).toContain("1 turn");
		expect(expanded.join("\n")).toContain("W3");
		expect(expanded.every((line) => visibleWidth(line) <= 60)).toBe(true);

		const second = await spawnAgent(harness, "Slow task");
		const timeoutArgs = { reasoning: "Check slow task", action: "wait", agent_ids: [second.details.agents[0].id], timeout_ms: 0 };
		const timeout = await harness.tool.execute("timeout", timeoutArgs, undefined, undefined, harness.ctx);
		const timedOut = rendered(harness.tool.renderResult(timeout, { isPartial: false, expanded: false }, renderTheme, { args: timeoutArgs }));
		expect(timedOut[0]).toBe("• Wait timed out Check slow task");
		expect(timedOut.join("\n")).toContain("running");

		const failed = rendered(harness.tool.renderResult(
			{ content: [{ type: "text", text: "Subagent not found" }] },
			{ isPartial: false, expanded: false },
			renderTheme,
			{ args: { reasoning: "Redirect delegated work", action: "send" }, isError: true },
		));
		expect(failed).toEqual([
			"• Agent action failed Redirect delegated work",
			"  └ Subagent not found",
		]);
	});

	test("renders automatic completion as the same expandable tool block", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "Review renderer");
		harness.clients[0].complete("Renderer matches the shared design.");
		await Bun.sleep(0);
		const message = harness.sentMessages[0].message;
		const renderer = harness.messageRenderers.get("subagent-result")!;
		const compactLines = rendered(renderer(message, { expanded: false }, renderTheme));
		expect(compactLines[0]).toContain("• Agent completed");
		expect(compactLines[1]).toContain("Review renderer");
		expect(compactLines.join("\n")).not.toContain("shared design");
		const expandedLines = rendered(renderer(message, { expanded: true }, renderTheme));
		expect(expandedLines.join("\n")).toContain("Renderer matches the shared design.");
	});

	test("uses the final assistant result after a successful retry", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "Retry transient failures");
		harness.clients[0].emit({ type: "message_update", message: assistant("partial output") });
		let listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0].output).toBe("");
		harness.clients[0].emit({ type: "message_end", message: assistant("", "error", "temporary failure") });
		harness.clients[0].emit({ type: "message_end", message: assistant("Recovered result") });
		harness.clients[0].emit({ type: "agent_settled" });
		listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "completed", error: undefined, output: "Recovered result" });
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

	test("starts with fresh conversation context when requested", async () => {
		const harness = createHarness({ withPendingToolCall: true });
		const started = await harness.tool.execute("call", {
			action: "spawn",
			task: "Inspect without history",
			fork_context: false,
		}, undefined, undefined, harness.ctx);
		expect(started.details.agents[0].contextMode).toBe("fresh");
		const lines = rendered(harness.tool.renderResult(started, { isPartial: false, expanded: false }, renderTheme, {
			args: { action: "spawn", task: "Inspect without history", fork_context: false },
		}));
		expect(lines[2]).toContain("fresh context");
		const args = harness.clients[0].options.args;
		const sessionPath = args[args.indexOf("--session") + 1];
		const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
		expect(messages).toEqual([]);
		expect(harness.clients[0].prompts[0]).toContain("No parent conversation was inherited");
	});

	test("uses a supplied name while lifecycle actions keep the generated ID", async () => {
		const harness = createHarness();
		const started = await harness.tool.execute("call", {
			action: "spawn",
			task: "Review the renderer",
			name: "renderer review",
		}, undefined, undefined, harness.ctx);
		const agent = started.details.agents[0];
		expect(agent.name).toBe("renderer review");
		expect(agent.id).toMatch(/^renderer-review-/);
		const lines = rendered(harness.tool.renderResult(started, { isPartial: false, expanded: false }, renderTheme, {
			args: { action: "spawn", task: "Review the renderer", name: "renderer review" },
		}));
		expect(lines[0]).toBe("• Spawned agent");
		expect(lines[1]).toBe("  └ Review the renderer");
		expect(lines[2]).toContain("● renderer review · renderer-rev");
		await harness.tool.execute("send", { action: "send", agent_id: agent.id, message: "Check tests too" }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].steering).toEqual(["Check tests too"]);
	});

	test("rejects invalid context inheritance values", async () => {
		const harness = createHarness();
		await expect(harness.tool.execute("call", {
			action: "spawn",
			task: "Inspect context",
			fork_context: "false",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("fork_context must be a boolean");
		expect(harness.clients).toHaveLength(0);
	});

	test("forks before a sequential tool batch with unresolved sibling calls", () => {
		const user = { role: "user", content: "Delegate after asking" };
		const assistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "question-call", name: "questionnaire", arguments: {} },
				{ type: "toolCall", id: "agent-call", name: "agents", arguments: { action: "spawn" } },
			],
		};
		const questionResult = { role: "toolResult", toolCallId: "question-call", toolName: "questionnaire", content: [] };
		const context = { messages: [user, assistantMessage, questionResult] } as any;
		expect(forkableMessages(context)).toEqual([user]);
		const agentResult = { role: "toolResult", toolCallId: "agent-call", toolName: "agents", content: [] };
		expect(forkableMessages({ messages: [...context.messages, agentResult] } as any)).toEqual([...context.messages, agentResult]);
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

	test("rejects oversized tasks and follow-ups before dispatch", async () => {
		const harness = createHarness();
		const taskLimit = harness.tool.parameters.properties.task.maxLength;
		const messageLimit = harness.tool.parameters.properties.message.maxLength;
		await expect(spawnAgent(harness, "x".repeat(taskLimit + 1))).rejects.toThrow("at most");
		expect(harness.clients).toHaveLength(0);
		const started = await spawnAgent(harness);
		await expect(harness.tool.execute("send", {
			action: "send",
			agent_id: started.details.agents[0].id,
			message: "x".repeat(messageLimit + 1),
		}, undefined, undefined, harness.ctx)).rejects.toThrow("at most");
		expect(harness.clients[0].steering).toHaveLength(0);
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
		expect(harness.overlay.definition.renderBody(54, 6, renderTheme)[2]).toContain("steered: Focus on tests");
		harness.clients[0].complete("Initial result");
		await harness.tool.execute("send-idle", { action: "send", agent_id: id, message: "Now inspect docs" }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].prompts.at(-1)).toBe("Now inspect docs");
		expect(harness.overlay.definition.renderBody(54, 6, renderTheme)[2]).toContain("follow-up: Now inspect");
	});

	test("preserves child state when steer or follow-up dispatch is rejected", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness);
		const id = started.details.agents[0].id;
		harness.clients[0].steerError = new Error("not streaming");
		await expect(harness.tool.execute("send-running", {
			action: "send", agent_id: id, message: "Race with completion",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("not streaming");
		let listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "running", error: undefined });

		harness.clients[0].steerError = undefined;
		harness.clients[0].complete("Initial result");
		await Bun.sleep(0);
		const notificationCount = harness.sentMessages.length;
		harness.clients[0].promptError = new Error("prompt rejected");
		await expect(harness.tool.execute("send-idle", {
			action: "send", agent_id: id, message: "Rejected follow-up",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("prompt rejected");
		await Bun.sleep(0);
		listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "completed", error: undefined, output: "Initial result" });
		expect(harness.sentMessages).toHaveLength(notificationCount);
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

	test("reserves concurrent spawn slots before asynchronous context creation", async () => {
		const harness = createHarness({ maxAgents: 2 });
		const outcomes = await Promise.allSettled([
			spawnAgent(harness, "First concurrent task"),
			spawnAgent(harness, "Second concurrent task"),
			spawnAgent(harness, "Third concurrent task"),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		const listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents).toHaveLength(2);
	});

	test("cancels a spawn that outlives parent session shutdown", async () => {
		let releaseContext!: () => void;
		const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
		const harness = createHarness({
			forkContext: async (ctx) => {
				await contextGate;
				return createContextFork(ctx);
			},
		});
		const spawning = spawnAgent(harness, "Race with parent shutdown");
		const observed = spawning.then(
			() => undefined,
			(error) => error instanceof Error ? error : new Error(String(error)),
		);
		const shutdown = harness.handlers.get("session_shutdown")?.({ reason: "reload" }, harness.ctx);
		releaseContext();
		await shutdown;
		const error = await observed;
		expect(error?.message).toContain("Parent session ended");
		expect(harness.clients).toHaveLength(0);
		expect(harness.overlay.unregistered).toBe(true);
	});

	test("retries close after stop failure and still clears live UI", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness);
		const id = started.details.agents[0].id;
		harness.clients[0].stopError = new Error("stop failed");
		await expect(harness.tool.execute("close", { action: "close", agent_id: id }, undefined, undefined, harness.ctx)).rejects.toThrow("stop failed");
		expect(harness.overlay.definition.visible()).toBe(false);
		expect(harness.statuses.get("subagents")).toBeUndefined();
		expect(harness.clients[0].stopped).toBe(false);
		harness.clients[0].stopError = undefined;
		await expect(harness.tool.execute("close", { action: "close", agent_id: id }, undefined, undefined, harness.ctx)).resolves.toBeDefined();
		expect(harness.clients[0].stopped).toBe(true);
	});

	test("finishes shutdown cleanup when one child stop fails", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "First shutdown task");
		await spawnAgent(harness, "Second shutdown task");
		harness.clients[0].stopError = new Error("first stop failed");
		await expect(harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx)).rejects.toThrow("Failed to clean up");
		expect(harness.clients[1].stopped).toBe(true);
		expect(harness.overlay.unregistered).toBe(true);
		expect(harness.statuses.get("subagents")).toBeUndefined();
	});

	test("bounds aggregate model-visible output", () => {
		const result = boundedText("x".repeat(100_000), 2_000);
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2_000);
		expect(result).toContain("output omitted");
	});
});
