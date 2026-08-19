import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createContextFork, forkableMessages, type CompactContext, type ContextMode } from "./context";
import registerSubagents, { boundedText } from "./index";
import { isProviderLimitError } from "./lifecycle";
import { RpcProcessClient, type AgentClient, type AgentClientFactory, type AgentClientOptions, type RpcAgentEvent } from "./rpc";

initTheme("dark", false);

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
	abortError?: Error;
	abortCalls = 0;
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
	async abort() {
		if (this.abortError) throw this.abortError;
		this.abortCalls += 1;
	}
	onEvent(listener: (event: RpcAgentEvent) => void) { this.events.add(listener); return () => this.events.delete(listener); }
	onExit(listener: (error: Error) => void) { this.exits.add(listener); return () => this.exits.delete(listener); }
	getStderr() { return ""; }
	emit(event: RpcAgentEvent) { for (const listener of [...this.events]) listener(event); }
	exit(error: Error) { for (const listener of [...this.exits]) listener(error); }
	report(message: string, callId = `report-${this.events.size}`) {
		this.emit({ type: "tool_execution_start", toolCallId: callId, toolName: "report_to_parent", args: { message } });
		this.emit({ type: "tool_execution_end", toolCallId: callId, toolName: "report_to_parent", isError: false, result: { content: [] } });
	}
	complete(text: string, stopReason = "stop") {
		this.emit({ type: "message_end", message: assistant(text, stopReason) });
		this.emit({ type: "agent_settled" });
	}
}

interface Harness {
	tool: any;
	commands: Map<string, any>;
	messageRenderers: Map<string, (...args: any[]) => any>;
	entryRenderers: Map<string, (...args: any[]) => any>;
	handlers: Map<string, (...args: any[]) => any>;
	clients: FakeClient[];
	sentMessages: Array<{ message: any; options: any }>;
	statuses: Map<string, string | undefined>;
	notifications: string[];
	emittedEvents: Array<{ name: string; data: any }>;
	overlay: OverlayRegistration;
	ctx: any;
	rootEditor: { getText(): string; setText(value: string): void; handleInput(data: string): void; delegated: string[] };
	getEditorFactory(): any;
	parent: SessionManager;
	storageRoot: string;
}

const harnesses: Harness[] = [];
const storageRoots = new Set<string>();

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
	}
	await Promise.all([...storageRoots].map((root) => rm(root, { recursive: true, force: true })));
	storageRoots.clear();
});

function createHarness(options: {
	maxAgents?: number;
	withPendingToolCall?: boolean;
	firstTurn?: boolean;
	failClientCreation?: boolean;
	forkContext?: typeof createContextFork;
	compactContext?: CompactContext;
	config?: any;
	clientFactory?: AgentClientFactory;
	parent?: SessionManager;
	storageRoot?: string;
	tui?: boolean;
} = {}): Harness {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messageRenderers = new Map<string, (...args: any[]) => any>();
	const entryRenderers = new Map<string, (...args: any[]) => any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const clients: FakeClient[] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const statuses = new Map<string, string | undefined>();
	const notifications: string[] = [];
	const emittedEvents: Array<{ name: string; data: any }> = [];
	let rootEditorText = "";
	const rootEditor = {
		delegated: [] as string[],
		getText: () => rootEditorText,
		setText(value: string) { rootEditorText = value; },
		handleInput(data: string) { rootEditor.delegated.push(data); },
	};
	let editorFactory: any = options.tui ? (() => rootEditor) : undefined;
	const storageRoot = options.storageRoot ?? mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
	storageRoots.add(storageRoot);
	const parent = options.parent ?? SessionManager.inMemory(process.cwd());
	if (!options.parent) {
		parent.appendModelChange("test-provider", "test-model");
		parent.appendThinkingLevelChange("medium");
		if (!options.firstTurn) {
			parent.appendMessage({ role: "user", content: "Original request", timestamp: Date.now() });
			parent.appendMessage(assistant("Original answer"));
		}
	}
	if (!options.parent && options.withPendingToolCall) {
		parent.appendMessage({ role: "user", content: "Delegate this", timestamp: Date.now() });
		parent.appendMessage({
			...assistant(""),
			content: [{ type: "toolCall", id: "call-1", name: "agents", arguments: { action: "spawn", task: "Inspect context" } }],
			stopReason: "toolUse",
		});
	}
	const ctx = {
		cwd: process.cwd(),
		mode: options.tui ? "tui" : undefined,
		model: { provider: "test-provider", id: "test-model" },
		sessionManager: parent,
		ui: {
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			notify(message: string) { notifications.push(message); },
			select: async () => undefined,
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory: any) { editorFactory = factory; },
		},
	};
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		registerMessageRenderer(type: string, renderer: (...args: any[]) => any) { messageRenderers.set(type, renderer); },
		registerEntryRenderer(type: string, renderer: (...args: any[]) => any) { entryRenderers.set(type, renderer); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		getActiveTools() { return ["read", "grep", "agents"]; },
		getThinkingLevel() { return "medium"; },
		appendEntry(customType: string, data: any) { parent.appendCustomEntry(customType, data); },
		sendMessage(message: any, messageOptions: any) { sentMessages.push({ message, options: messageOptions }); },
		events: {
			emit(name: string, data: any) { emittedEvents.push({ name, data }); },
			on() { return () => {}; },
		},
	};
	let overlay: OverlayRegistration | undefined;
	registerSubagents(pi as any, {
		maxAgents: options.maxAgents,
		config: options.config,
		createContextFork: options.forkContext,
		compactContext: options.compactContext,
		storageRoot,
		registerOverlayCard(definition) {
			overlay = { definition, invalidations: 0, unregistered: false };
			return {
				invalidate() { overlay!.invalidations += 1; },
				unregister() { overlay!.unregistered = true; },
			};
		},
		createClient(clientOptions) {
			if (options.failClientCreation) throw new Error("client factory failed");
			if (options.clientFactory) return options.clientFactory(clientOptions);
			const client = new FakeClient(clientOptions);
			clients.push(client);
			return client;
		},
	});
	if (!overlay) throw new Error("Subagents overlay was not registered");
	const harness = {
		tool: tools.get("agents"), commands, messageRenderers, entryRenderers, handlers, clients, sentMessages, statuses, notifications,
		emittedEvents, overlay, ctx, rootEditor, getEditorFactory: () => editorFactory, parent, storageRoot,
	};
	harnesses.push(harness);
	void handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return harness;
}

let agentNameSequence = 0;

async function spawnAgent(harness: Harness, task = "Inspect the repository", context?: ContextMode) {
	const name = `test-agent-${++agentNameSequence}`;
	return harness.tool.execute("call", { action: "spawn", task, name, ...(context ? { context } : {}) }, undefined, undefined, harness.ctx);
}

const renderTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const semanticTheme = {
	fg(color: string, text: string) {
		const codes: Record<string, number> = { accent: 35, success: 32, error: 31, warning: 33, muted: 90, dim: 2, text: 39, toolTitle: 36, toolOutput: 37, mdHeading: 36 };
		return `\x1b[${codes[color] ?? 39}m${text}\x1b[0m`;
	},
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
			"reasoning", "action", "task", "context", "name", "agent_name", "message", "agent_names", "return_when", "wake_on", "timeout_ms",
		]);
		expect(harness.tool.parameters.required).toEqual(["reasoning", "action"]);
		expect(harness.tool.parameters.properties).not.toHaveProperty("agent_type");
		expect(harness.tool.parameters.properties).not.toHaveProperty("model");
		expect(harness.tool.parameters.properties.task.maxLength).toBe(16_000);
		expect(harness.tool.parameters.properties.message.maxLength).toBe(16_000);
		expect(harness.tool.description).toContain("inherit the current model");
		expect(harness.tool.description).toContain("quota exhaustion pauses a child");
		expect(harness.tool.description).toContain("checkpoint open conversations");
		expect(harness.tool.parameters.properties.context).toMatchObject({ enum: ["fresh", "compacted", "forked"], description: expect.stringContaining("default fresh") });
		expect(harness.tool.parameters.properties.name).toMatchObject({ maxLength: 80, description: expect.stringContaining("Required unique") });
		expect(harness.tool.parameters.properties.return_when).toMatchObject({ enum: ["any", "all"], description: expect.stringContaining("default any") });
		expect(harness.tool.parameters.properties.timeout_ms.description).toContain("default 300000, min 0, max 3600000");
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("context=compacted") && guideline.includes("context=forked"))).toBe(true);
		expect(harness.tool.parameters.properties.action.enum).toEqual(["spawn", "message", "followup", "send", "wait", "list", "read", "interrupt", "close"]);
		expect(harness.tool.parameters.properties.wake_on).toMatchObject({ enum: ["any", "final"], description: expect.stringContaining("default any") });
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("action=close") && guideline.includes("conversation slot"))).toBe(true);
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("action=read") && guideline.includes("action=interrupt"))).toBe(true);
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("return_when=all") && guideline.includes("first mailbox update by default"))).toBe(true);
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("Never ask a healthy running agent") && guideline.includes("wait timed out"))).toBe(true);
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("Provider usage") && guideline.includes("action=followup") && guideline.includes("paused child"))).toBe(true);
		expect(harness.tool.promptGuidelines.some((guideline: string) => guideline.includes("Reload, quit") && guideline.includes("restore them hibernated"))).toBe(true);
		expect(harness.tool.prepareArguments({ action: "send", agent_id: "legacy-id" })).toEqual({ action: "send", agent_name: "legacy-id" });
		expect(harness.tool.prepareArguments({ action: "wait", agent_ids: ["legacy-a"] })).toEqual({ action: "wait", agent_names: ["legacy-a"] });
	});

	test("exposes a bounded progress reporter only inside child processes", async () => {
		const previous = process.env.PI_SUBAGENT_CHILD;
		const tools = new Map<string, any>();
		try {
			process.env.PI_SUBAGENT_CHILD = "1";
			registerSubagents({ registerTool(definition: any) { tools.set(definition.name, definition); } } as any);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previous;
		}
		expect([...tools.keys()]).toEqual(["report_to_parent"]);
		const reporter = tools.get("report_to_parent");
		expect(reporter.parameters.properties.message.maxLength).toBe(4_000);
		const result = await reporter.execute("report", { reasoning: "Share useful progress", message: "API schema is stable" });
		expect(result.content[0].text).toBe("Reported to parent: API schema is stable");
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
		expect(toolsArg).toBe("read,grep,report_to_parent");
		expect(started.details.agents[0].status).toBe("running");
		expect(client.prompts[0]).toContain(`Child agent name: ${started.details.agents[0].name}`);
		expect(started.content[0].text).toContain(`Started ${started.details.agents[0].name}`);
		expect(started.content[0].text).not.toContain(started.details.agents[0].id);
		expect(harness.statuses.size).toBe(0);

		const sessionFile = client.options.args[client.options.args.indexOf("--session") + 1];
		client.complete("Found the relevant files.\u001b]0;unsafe\u0007");
		await Bun.sleep(0);
		expect(client.stopped).toBe(true);
		expect(existsSync(sessionFile)).toBe(true);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.content).toContain("Found the relevant files.");
		expect(harness.sentMessages[0].message.content).toContain(`Agent: ${started.details.agents[0].name}`);
		expect(harness.sentMessages[0].message.content).not.toContain(started.details.agents[0].id);
		expect(harness.sentMessages[0].message.content).not.toContain("\u001b");
		expect(harness.sentMessages[0].options).toEqual({ triggerTurn: false });
		expect(harness.statuses.size).toBe(0);
		const usageEntry = [...harness.parent.getEntries()].reverse().find((entry: any) => entry.customType === "subagent-usage");
		expect(usageEntry).toMatchObject({
			type: "custom",
			customType: "subagent-usage",
			data: {
				version: 1,
				provider: "test-provider",
				model: "test-model",
				usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: 0.01 },
			},
		});
	});

	test("shows active agents in the shared overlay and hides them after completion", async () => {
		const harness = createHarness();
		const card = harness.overlay.definition;
		expect({ id: card.id, order: card.order, width: card.width }).toEqual({ id: "subagents", order: 15, width: 58 });
		expect(card.visible()).toBe(false);

		const started = await spawnAgent(harness, "Inspect a very long repository task whose description must fit the overlay");
		const name = started.details.agents[0].name;
		expect(card.visible()).toBe(true);
		expect(card.title(renderTheme)).toContain("Agents ● 1 running");
		let body = card.renderBody(54, 6, renderTheme);
		expect(body).toHaveLength(3);
		expect(body[0]).toContain(name);
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
		expect(card.visible()).toBe(true);
		expect(card.renderBody(54, 6, renderTheme)[0]).toContain("1 unread");
		await Bun.sleep(0);
		expect(card.visible()).toBe(false);
		expect(card.renderBody(54, 6, renderTheme)).toEqual([]);
		const listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents.find((agent: any) => agent.name === name)?.status).toBe("completed");
		expect(harness.clients[0].stopped).toBe(true);

		await harness.tool.execute("close", { action: "close", agent_name: name }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].stopped).toBe(true);
		await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
		expect(harness.overlay.unregistered).toBe(true);
		harnesses.splice(harnesses.indexOf(harness), 1);
	});

	test("shows unread mailbox counts and delivery metrics in /agents", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await spawnAgent(harness, "Inspect mailbox metrics");
		harness.clients[0].report("Unread update");
		const card = harness.overlay.definition;
		expect(card.title(renderTheme)).toContain("✉ 1 unread");
		expect(card.renderBody(54, 6, renderTheme)[0]).toContain("1 unread");

		harness.ctx.ui.select = async (_title: string, labels: string[]) => labels[0];
		await harness.commands.get("agents").handler("", harness.ctx);
		expect(harness.notifications.at(-1)).toContain("1 unread");
		expect(harness.notifications.at(-1)).toContain("1 published");
	});

	test("opens a live child-only transcript from /agents", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Inspect transcript behavior", "forked");
		const client = harness.clients[0];
		const sessionPath = client.options.args[client.options.args.indexOf("--session") + 1];
		const child = SessionManager.open(sessionPath);
		child.appendMessage({ role: "user", content: client.prompts[0], timestamp: Date.now() });
		child.appendMessage({
			...assistant(""),
			content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "extensions/subagents/index.ts" } }],
			stopReason: "toolUse",
		});

		let component: any;
		let overlayOptions: any;
		let renderRequests = 0;
		harness.ctx.ui.select = async (_title: string, labels: string[]) => labels[1];
		harness.ctx.ui.custom = async (factory: any, options: any) => {
			overlayOptions = options;
			await new Promise<void>((resolve) => {
				component = factory({ requestRender() { renderRequests += 1; } }, renderTheme, {}, resolve);
			});
		};

		const viewing = harness.commands.get("agents").handler("", harness.ctx);
		await Bun.sleep(0);
		const initial = rendered(component, 100).join("\n");
		expect(initial).toContain(`← Parent  ·  [${started.details.agents[0].name}]`);
		expect(initial).toContain("● running  ·  forked context  ·  test-provider/test-model");
		expect(initial).toContain("Task  Inspect transcript behavior");
		expect(initial).toContain("› Task\n  Inspect transcript behavior");
		expect(initial).toContain("◆ Tool · read");
		expect(initial).not.toContain("Original request");
		expect(initial).not.toContain("You are a delegated child agent");
		expect(overlayOptions).toMatchObject({ overlay: true, overlayOptions: { width: "95%", maxHeight: "92%" } });
		expect(harness.emittedEvents.at(-1)).toEqual({ name: "modal-overlay", data: { id: "subagents-transcript", hidden: true } });

		const toolResult = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "live child output" }],
			isError: false,
			timestamp: Date.now(),
		};
		child.appendMessage(toolResult);
		client.emit({ type: "message_end", message: toolResult });
		expect(renderRequests).toBeGreaterThan(0);
		expect(rendered(component, 100).join("\n")).toContain("✓ Tool result · read\n  live child output");

		component.handleInput("q");
		await viewing;
		expect(harness.emittedEvents.at(-1)).toEqual({ name: "modal-overlay", data: { id: "subagents-transcript", hidden: false } });
	});

	test("opens the first child with Right from an empty parent input", async () => {
		const harness = createHarness({ tui: true });
		const first = await spawnAgent(harness, "First retained transcript");
		const second = await spawnAgent(harness, "Second retained transcript");
		let component: any;
		harness.ctx.ui.custom = async (factory: any) => {
			await new Promise<void>((resolve) => {
				component = factory({ requestRender() {} }, renderTheme, {}, resolve);
			});
		};
		const editor = harness.getEditorFactory()({}, {}, {});

		editor.handleInput("\x1b[C");
		await Bun.sleep(0);
		expect(rendered(component, 100).join("\n")).toContain(`[${first.details.agents[0].name}]  ·  ${second.details.agents[0].name} →`);

		component.handleInput("\x1b[D");
		await Bun.sleep(0);
	});

	test("keeps completed children out of keyboard navigation", async () => {
		const harness = createHarness({ tui: true });
		await spawnAgent(harness, "Completed retained transcript");
		harness.clients[0].complete("Done");
		await Bun.sleep(0);
		let customCalls = 0;
		harness.ctx.ui.custom = async () => { customCalls += 1; };
		const editor = harness.getEditorFactory()({}, {}, {});

		editor.handleInput("\x1b[C");
		await Bun.sleep(0);
		expect(customCalls).toBe(0);
		expect(harness.rootEditor.delegated).toEqual(["\x1b[C"]);
	});

	test("moves between child transcripts without cycling", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "First transcript task");
		const second = await spawnAgent(harness, "Second transcript task");
		let component: any;
		harness.ctx.ui.select = async (_title: string, labels: string[]) => labels.find((label) => label.includes(first.details.agents[0].name));
		harness.ctx.ui.custom = async (factory: any) => {
			await new Promise<void>((resolve) => {
				component = factory({ requestRender() {} }, renderTheme, {}, resolve);
			});
		};

		const viewing = harness.commands.get("agents").handler("", harness.ctx);
		await Bun.sleep(0);
		expect(rendered(component, 100).join("\n")).toContain(`[${first.details.agents[0].name}]  ·  ${second.details.agents[0].name} →`);

		component.handleInput("\x1b[C");
		expect(rendered(component, 100).join("\n")).toContain(`← ${first.details.agents[0].name}  ·  [${second.details.agents[0].name}]`);
		component.handleInput("\x1b[C");
		expect(rendered(component, 100).join("\n")).toContain(`← ${first.details.agents[0].name}  ·  [${second.details.agents[0].name}]`);

		component.handleInput("\x1b[D");
		expect(rendered(component, 100).join("\n")).toContain(`[${first.details.agents[0].name}]  ·  ${second.details.agents[0].name} →`);
		component.handleInput("\x1b[D");
		await viewing;
	});

	test("keeps the final transcript visible and can move to the next running child", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "Finishing transcript task");
		const second = await spawnAgent(harness, "Still running transcript task");
		let component: any;
		harness.ctx.ui.select = async (_title: string, labels: string[]) => labels.find((label) => label.includes(first.details.agents[0].name));
		harness.ctx.ui.custom = async (factory: any) => {
			await new Promise<void>((resolve) => {
				component = factory({ requestRender() {} }, renderTheme, {}, resolve);
			});
		};

		const viewing = harness.commands.get("agents").handler("", harness.ctx);
		await Bun.sleep(0);
		const firstSessionPath = harness.clients[0].options.args[harness.clients[0].options.args.indexOf("--session") + 1];
		SessionManager.open(firstSessionPath).appendMessage(assistant("Finished while open"));
		harness.clients[0].complete("Finished while open");
		await Bun.sleep(0);
		expect(rendered(component, 100).join("\n")).toContain("✓ completed");
		expect(rendered(component, 100).join("\n")).toContain("● Agent\n  Finished while open");

		component.handleInput("\x1b[C");
		expect(rendered(component, 100).join("\n")).toContain(`[${second.details.agents[0].name}]`);
		component.handleInput("q");
		await viewing;
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
		const args = { reasoning: "Delegate repository inspection", action: "spawn", task: "Inspect the repository", name: "repository inspector" };
		const call = harness.tool.renderCall(args, renderTheme, { isPartial: true, args });
		expect(rendered(call)).toEqual([
			"• Spawning agent repository inspector with fresh context to Delegate repository inspection",
			"  └ Task    Inspect the repository",
		]);
		expect(call.render(100)[0]).toContain("\x1b[35m•\x1b[0m \x1b[1mSpawning agent repository inspector with fresh context\x1b[0m");
		expect(rendered(harness.tool.renderCall(args, renderTheme, { isPartial: false, args }))).toEqual([]);

		const result = await harness.tool.execute("spawn", args, undefined, undefined, harness.ctx);
		const settled = harness.tool.renderResult(result, { isPartial: false, expanded: false }, renderTheme, {
			lastComponent: call,
			args,
			isError: false,
		});
		expect(settled).toBe(call);
		const lines = rendered(settled);
		expect(lines[0]).toBe("• Spawned agent repository inspector with fresh context to Delegate repository inspection");
		expect(settled.render(100)[0]).toContain("\x1b[32m•\x1b[0m \x1b[1mSpawned agent repository inspector with fresh context\x1b[0m");
		const styledHeadline = harness.tool.renderResult(result, { isPartial: false, expanded: false }, semanticTheme, { args }).render(100)[0];
		expect(styledHeadline).toContain("\x1b[36mrepository inspector\x1b[0m");
		expect(styledHeadline).toContain("\x1b[90mfresh context\x1b[0m");
		expect(styledHeadline).toContain("\x1b[2mto\x1b[0m \x1b[35mDelegate repository inspection\x1b[0m");
		expect(lines.join("\n")).not.toContain(result.details.agents[0].id);
		expect(lines[1]).toBe("    Task    Inspect the repository");
		expect(lines.join("\n")).not.toMatch(/\b\d+ms\b/);
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	test("renders wait timeouts, expanded results, and errors semantically", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "Inspect API");
		const waitArgs = { reasoning: "Collect delegated review", action: "wait", agent_names: [first.details.agents[0].name], timeout_ms: 1_000 };
		const waiting = harness.tool.execute("wait", waitArgs, undefined, undefined, harness.ctx);
		harness.clients[0].complete("API review complete.");
		const waited = await waiting;
		const collapsed = rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: false }, renderTheme, { args: waitArgs }));
		expect(collapsed[0]).toBe("• Updates received — Collect delegated review");
		expect(collapsed[1]).toBe("");
		expect(collapsed[2]).toContain(first.details.agents[0].name);
		expect(collapsed[3]).toBe("    Task    Inspect API");
		expect(collapsed[5]).toBe("    Result");
		expect(collapsed[6]).toBe("    API review complete.");
		expect(collapsed[8]).toContain("    1 turn · ↑10 · ↓5 · R2 · W3 · $0.0100 · test-provider/test-model");
		expect(harness.sentMessages).toHaveLength(0);
		const expanded = rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: true }, renderTheme, { args: waitArgs }), 60);
		expect(expanded.join("\n")).toContain("API review complete.");
		expect(expanded.join("\n")).toContain("1 turn");
		expect(expanded.join("\n")).toContain("W3");
		expect(expanded.every((line) => visibleWidth(line) <= 60)).toBe(true);

		const second = await spawnAgent(harness, "Slow task");
		const timeoutArgs = { reasoning: "Wait for first full documentation group", action: "wait", agent_names: [second.details.agents[0].name], timeout_ms: 0 };
		const partialWait = rendered(harness.tool.renderCall(timeoutArgs, renderTheme, { isPartial: true, args: timeoutArgs }));
		expect(partialWait[0]).toBe("• Waiting for agents — Wait for first full documentation group");
		const timeout = await harness.tool.execute("timeout", timeoutArgs, undefined, undefined, harness.ctx);
		const timedOut = rendered(harness.tool.renderResult(timeout, { isPartial: false, expanded: false }, renderTheme, { args: timeoutArgs }));
		expect(timedOut[0]).toBe("• Wait timed out · 1 agent still running — Wait for first full documentation group");
		expect(timedOut.join("\n")).toContain("running");
		expect(timeout.content[0].text).toStartWith("No mailbox update arrived during this wait interval.\nAgents continue running and updates remain queued without forcing a parent turn. Do not ask healthy running agents to stop or finalize because of this timeout.\n");

		const failed = rendered(harness.tool.renderResult(
			{ content: [{ type: "text", text: "Subagent not found" }] },
			{ isPartial: false, expanded: false },
			renderTheme,
			{ args: { reasoning: "Redirect delegated work", action: "send" }, isError: true },
		));
		expect(failed).toEqual([
			"• Agent action failed to Redirect delegated work",
			"  └ Subagent not found",
		]);
	});

	test("collapses long waited output like bash and expands with Ctrl+O", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Produce a detailed review");
		const name = started.details.agents[0].name;
		const output = Array.from({ length: 8 }, (_, index) => `review line ${index + 1}`).join("\n");
		const waitArgs = { action: "wait", agent_names: [name], timeout_ms: 1_000 };
		const waiting = harness.tool.execute("wait-long-output", waitArgs, undefined, undefined, harness.ctx);
		harness.clients[0].complete(output);
		const waited = await waiting;

		const collapsed = rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: false }, renderTheme, { args: waitArgs }), 100);
		expect(collapsed.slice(5, 11)).toEqual([
			"    Result",
			"    review line 4",
			"    review line 5",
			"    review line 6",
			"    review line 7",
			"    review line 8",
		]);
		expect(collapsed.join("\n")).not.toContain("review line 1");
		expect(collapsed.at(-2)).toContain("1 turn");
		expect(collapsed.at(-1)).toBe("    Ctrl+O for full result · 3 earlier lines hidden");

		const expanded = rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: true }, renderTheme, { args: waitArgs }), 100);
		expect(expanded.join("\n")).toContain("review line 1");
		expect(expanded.join("\n")).toContain("review line 8");
		expect(expanded.join("\n")).not.toContain("Ctrl+O for full output");
	});

	test("renders automatic completion as the same expandable tool block", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "Review renderer");
		harness.clients[0].complete("Renderer matches the shared design.");
		await Bun.sleep(0);
		const message = harness.sentMessages[0].message;
		const renderer = harness.messageRenderers.get("subagent-result")!;
		const compactLines = rendered(renderer(message, { expanded: false }, renderTheme));
		expect(compactLines[0]).toBe("• Agent completed");
		expect(compactLines[1]).toBe("");
		expect(compactLines[2]).toContain(`✓ ${message.details.name}`);
		expect(compactLines.join("\n")).not.toContain(message.details.id);
		expect(compactLines[2]).not.toContain("context");
		expect(compactLines[3]).toBe("    Task    Review renderer");
		expect(compactLines[5]).toBe("    Result");
		expect(compactLines[6]).toBe("    Renderer matches the shared design.");
		expect(compactLines[8]).toContain("    1 turn · ↑10 · ↓5 · R2 · W3 · $0.0100 · test-provider/test-model");
		const styledLines = renderer(message, { expanded: false }, semanticTheme).render(100);
		expect(styledLines[2]).toContain(`\x1b[39m${message.details.name}\x1b[0m`);
		expect(styledLines[3]).toContain("\x1b[90mTask  \x1b[0m  \x1b[90mReview renderer\x1b[0m");
		expect(styledLines[5]).toContain("\x1b[36mResult\x1b[0m");
		expect(styledLines[6]).toContain("\x1b[37mRenderer matches the shared design.");
		expect(styledLines[8]).toContain("\x1b[2m1 turn");
		const waitArgs = { reasoning: "Collect reported result", action: "wait", agent_names: [message.details.name], timeout_ms: 1_000 };
		const waited = await harness.tool.execute("wait", waitArgs, undefined, undefined, harness.ctx);
		expect(waited.details.alreadyReportedAgentIds).toEqual([message.details.id]);
		expect(rendered(harness.tool.renderResult(waited, { isPartial: false, expanded: false }, renderTheme, { args: waitArgs }))).toEqual([]);
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

	test("recognizes provider quota errors without confusing context failures", () => {
		expect(isProviderLimitError("Codex error: The usage limit has been reached")).toBe(true);
		expect(isProviderLimitError("HTTP status 429: too many requests")).toBe(true);
		expect(isProviderLimitError("insufficient_quota: credit balance is too low")).toBe(true);
		expect(isProviderLimitError("Weekly limit reached; resets tomorrow")).toBe(true);
		expect(isProviderLimitError("Your input exceeds the context window of this model")).toBe(false);
		expect(isProviderLimitError("Agent process exited unexpectedly")).toBe(false);
	});

	test("does not cancel children when the parent run settles after a provider error", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await spawnAgent(harness, "Keep working across the parent limit");
		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		const listed = await harness.tool.execute("list-after-parent-error", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0].status).toBe("running");
		expect(harness.clients[0].stopped).toBe(false);
		expect(harness.clients[0].abortCalls).toBe(0);
	});

	test("pauses quota-limited children and resumes their retained conversation", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Continue after quota reset");
		const name = started.details.agents[0].name;
		const firstClient = harness.clients[0];
		const sessionFile = firstClient.options.args[firstClient.options.args.indexOf("--session") + 1];
		const limitError = "Codex error: The usage limit has been reached";
		firstClient.emit({ type: "message_end", message: assistant("", "error", limitError) });
		firstClient.emit({ type: "agent_settled" });
		await Bun.sleep(0);

		const paused = await harness.tool.execute("list-paused", { action: "list" }, undefined, undefined, harness.ctx);
		expect(paused.details.agents[0]).toMatchObject({ status: "paused", error: limitError, output: "" });
		expect(firstClient.stopped).toBe(true);
		expect(existsSync(sessionFile)).toBe(true);
		expect(harness.sentMessages.at(-1)).toMatchObject({
			message: {
				customType: "subagent-result",
				content: expect.stringContaining("send this agent a follow-up"),
				details: { status: "paused", error: limitError },
			},
			options: { triggerTurn: false },
		});
		const completion = harness.messageRenderers.get("subagent-result")!(harness.sentMessages.at(-1)!.message, { expanded: false }, renderTheme);
		const completionLines = rendered(completion);
		expect(completionLines[0]).toBe("• Agent paused");
		expect(completion.render(100)[0]).toContain("\x1b[33m•\x1b[0m");
		expect(completionLines[2]).toContain("Ⅱ");
		expect(completionLines[0]).toContain("paused");

		await harness.tool.execute("resume-paused", {
			action: "followup",
			agent_name: name,
			message: "Continue now that the provider limit has reset",
		}, undefined, undefined, harness.ctx);
		expect(harness.clients).toHaveLength(2);
		expect(harness.clients[1].options.args[harness.clients[1].options.args.indexOf("--session") + 1]).toBe(sessionFile);
		expect(harness.clients[1].prompts).toEqual(["Continue now that the provider limit has reset"]);
		const resumed = await harness.tool.execute("list-resumed", { action: "list" }, undefined, undefined, harness.ctx);
		expect(resumed.details.agents[0]).toMatchObject({ status: "running", error: undefined, output: "" });
	});

	test("keeps non-quota provider errors failed", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "Fail on invalid context");
		const error = "Your input exceeds the context window of this model";
		harness.clients[0].emit({ type: "message_end", message: assistant("", "error", error) });
		harness.clients[0].emit({ type: "agent_settled" });
		const listed = await harness.tool.execute("list-failed", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "failed", error });
	});

	test("forks inherited context before the unresolved delegating tool call", async () => {
		const harness = createHarness({ withPendingToolCall: true });
		await spawnAgent(harness, "Inspect context", "forked");
		const args = harness.clients[0].options.args;
		const sessionPath = args[args.indexOf("--session") + 1];
		expect(existsSync(sessionPath)).toBe(true);
		const child = SessionManager.open(sessionPath);
		const messages = child.buildSessionContext().messages;
		expect(messages.some((message: any) => message.role === "user" && message.content === "Delegate this")).toBe(true);
		expect(messages.some((message: any) => message.role === "assistant" && message.content?.some?.((part: any) => part.type === "toolCall"))).toBe(false);
	});

	test("starts with fresh conversation context by default", async () => {
		const harness = createHarness({ withPendingToolCall: true });
		const started = await harness.tool.execute("call", {
			action: "spawn",
			task: "Inspect without history",
			name: "history-free inspector",
		}, undefined, undefined, harness.ctx);
		expect(started.details.agents[0].contextMode).toBe("fresh");
		const lines = rendered(harness.tool.renderResult(started, { isPartial: false, expanded: false }, renderTheme, {
			args: { action: "spawn", task: "Inspect without history", name: "history-free inspector" },
		}));
		expect(lines[0]).toContain("with fresh context");
		const args = harness.clients[0].options.args;
		const sessionPath = args[args.indexOf("--session") + 1];
		const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
		expect(messages).toEqual([]);
		expect(harness.clients[0].prompts[0]).toContain("No parent conversation was inherited");
	});

	test("reuses one compacted snapshot for concurrent spawns", async () => {
		let releaseSummary!: () => void;
		const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
		let summaryCalls = 0;
		const harness = createHarness({
			compactContext: async (_ctx, messages) => {
				summaryCalls += 1;
				expect(messages.some((message: any) => message.role === "user" && message.content === "Original request")).toBe(true);
				await summaryGate;
				return "## Current work\nKeep the protocol stable.";
			},
		});
		const first = harness.tool.execute("compact-first", {
			action: "spawn", task: "Inspect API", name: "compacted API", context: "compacted",
		}, undefined, undefined, harness.ctx);
		const second = harness.tool.execute("compact-second", {
			action: "spawn", task: "Inspect tests", name: "compacted tests", context: "compacted",
		}, undefined, undefined, harness.ctx);
		await Bun.sleep(0);
		expect(summaryCalls).toBe(1);
		releaseSummary();
		const started = await Promise.all([first, second]);
		expect(started.map((result) => result.details.agents[0].contextMode)).toEqual(["compacted", "compacted"]);
		for (const client of harness.clients) {
			const args = client.options.args;
			const sessionPath = args[args.indexOf("--session") + 1];
			const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
			expect(JSON.stringify(messages)).toContain("Compacted parent conversation");
			expect(JSON.stringify(messages)).toContain("Keep the protocol stable");
			expect(client.prompts[0]).toContain("A compacted parent-conversation summary was inherited");
		}
	});

	test("retries compacted context after summary failure", async () => {
		let summaryCalls = 0;
		const harness = createHarness({
			compactContext: async () => {
				summaryCalls += 1;
				if (summaryCalls === 1) throw new Error("summary unavailable");
				return "Recovered summary";
			},
		});
		const args = { action: "spawn", task: "Inspect API", name: "retry compact", context: "compacted" };
		await expect(harness.tool.execute("compact-fail", args, undefined, undefined, harness.ctx)).rejects.toThrow("summary unavailable");
		await expect(harness.tool.execute("compact-retry", args, undefined, undefined, harness.ctx)).resolves.toBeDefined();
		expect(summaryCalls).toBe(2);
		expect(harness.clients).toHaveLength(1);
	});

	test("uses names for lifecycle actions while IDs remain internal", async () => {
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
		expect(lines[0]).toBe("• Spawned agent renderer review with fresh context");
		expect(lines.join("\n")).not.toContain(agent.id);
		expect(lines[1]).toBe("    Task    Review the renderer");
		const styled = harness.tool.renderResult(started, { isPartial: false, expanded: false }, semanticTheme, {
			args: { action: "spawn", task: "Review the renderer", name: "renderer review" },
		}).render(100);
		expect(styled[0]).toContain("\x1b[36mrenderer review\x1b[0m");
		expect(styled[0]).toContain("\x1b[90mfresh context\x1b[0m");
		expect(styled[0]).not.toContain("running");
		expect(styled[1]).toContain("\x1b[90mTask  \x1b[0m  \x1b[90mReview the renderer\x1b[0m");
		const sendArgs = { reasoning: "Refine delegated review", action: "send", agent_name: agent.name, message: "Check tests too" };
		const sent = await harness.tool.execute("send", sendArgs, undefined, undefined, harness.ctx);
		expect(harness.clients[0].steering).toEqual(["Check tests too"]);
		const sentLines = rendered(harness.tool.renderResult(sent, { isPartial: false, expanded: false }, renderTheme, { args: sendArgs }));
		expect(sentLines[0]).toBe("• Sent follow-up to renderer review to Refine delegated review");
		expect(sentLines[1]).toBe("    Message  Check tests too");
		const closeArgs = { reasoning: "Release delegated reviewer", action: "close", agent_name: agent.name };
		const closed = await harness.tool.execute("close", closeArgs, undefined, undefined, harness.ctx);
		const closedLines = rendered(harness.tool.renderResult(closed, { isPartial: false, expanded: false }, renderTheme, { args: closeArgs }));
		expect(closedLines).toEqual(["• Closed agent renderer review to Release delegated reviewer"]);
	});

	test("shows concise outbound previews and complete expanded communications", async () => {
		const harness = createHarness();
		const task = `Inspect the integration. ${"task-detail ".repeat(30)}\n\nTASK-END`;
		const spawnArgs = { reasoning: "Delegate integration audit", action: "spawn", task, name: "integration auditor" };
		const started = await harness.tool.execute("spawn-expanded", spawnArgs, undefined, undefined, harness.ctx);
		const collapsedTask = rendered(harness.tool.renderResult(started, { isPartial: false, expanded: false }, renderTheme, { args: spawnArgs }), 64);
		expect(collapsedTask).toHaveLength(2);
		expect(collapsedTask[1]).toStartWith("    Task    Inspect the integration.");
		expect(collapsedTask.join("\n")).not.toContain("TASK-END");
		const expandedTask = rendered(harness.tool.renderResult(started, { isPartial: false, expanded: true }, renderTheme, { args: spawnArgs }), 64);
		expect(expandedTask).toContain(`${" ".repeat(12)}TASK-END`);
		expect(expandedTask.every((line) => visibleWidth(line) <= 64)).toBe(true);

		const message = `Root configuration is ready. ${"message-detail ".repeat(30)}\n\nMESSAGE-END`;
		const messageArgs = { reasoning: "Share integration context", action: "message", agent_name: "integration auditor", message };
		const queued = await harness.tool.execute("message-expanded", messageArgs, undefined, undefined, harness.ctx);
		expect(harness.clients[0].steering).toEqual([message]);
		const collapsedMessage = rendered(harness.tool.renderResult(queued, { isPartial: false, expanded: false }, renderTheme, { args: messageArgs }), 100);
		expect(collapsedMessage).toHaveLength(2);
		expect(collapsedMessage[0]).toBe("• Queued message for integration auditor to Share integration context");
		expect(collapsedMessage[1]).toStartWith("    Message  Root configuration is ready.");
		expect(collapsedMessage.join("\n")).not.toContain("MESSAGE-END");
		const expandedMessage = rendered(harness.tool.renderResult(queued, { isPartial: false, expanded: true }, renderTheme, { args: messageArgs }), 100);
		expect(expandedMessage[0]).toBe("• Queued message for integration auditor to Share integration context");
		expect(expandedMessage).toContain(`${" ".repeat("    Message  ".length)}MESSAGE-END`);
		expect(expandedMessage.join("\n")).not.toContain("…");
		expect(expandedMessage.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	test("requires unique case-insensitive names across concurrent and closed agents", async () => {
		const harness = createHarness();
		await expect(harness.tool.execute("missing-name", {
			action: "spawn",
			task: "Missing name",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("requires an agent name");

		const attempts = await Promise.allSettled([
			harness.tool.execute("first-name", { action: "spawn", task: "First", name: "API reviewer" }, undefined, undefined, harness.ctx),
			harness.tool.execute("duplicate-name", { action: "spawn", task: "Second", name: "  api   REVIEWER  " }, undefined, undefined, harness.ctx),
		]);
		expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(String(rejected?.reason)).toContain("Agent name already exists");

		const active = (await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx)).details.agents[0];
		await harness.tool.execute("close", { action: "close", agent_name: active.name }, undefined, undefined, harness.ctx);
		await expect(harness.tool.execute("reuse-name", {
			action: "spawn",
			task: "Third",
			name: "api reviewer",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("Agent name already exists");
	});

	test("rejects invalid context modes", async () => {
		const harness = createHarness();
		await expect(harness.tool.execute("call", {
			action: "spawn",
			task: "Inspect context",
			name: "context inspector",
			context: "stale",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("context must be fresh, compacted, or forked");
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
		await spawnAgent(harness, "Inspect first turn", "forked");
		const args = harness.clients[0].options.args;
		const sessionPath = args[args.indexOf("--session") + 1];
		expect(existsSync(sessionPath)).toBe(true);
		const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
		expect(messages.map((message: any) => message.role)).toEqual(["user"]);
		expect(messages[0].content).toBe("Delegate this");
	});

	test("rejects missing agent names", async () => {
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
			agent_name: started.details.agents[0].name,
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
		const fork = await createContextFork(harness.ctx, "fresh");
		const first = fork.cleanup();
		const second = fork.cleanup();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(existsSync(fork.directory)).toBe(false);
	});

	test("publishes interim reports only after successful tool execution", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await spawnAgent(harness, "Inspect reporter failures");
		harness.clients[0].emit({
			type: "tool_execution_start",
			toolCallId: "failed-report",
			toolName: "report_to_parent",
			args: { message: "Do not publish this" },
		});
		harness.clients[0].emit({
			type: "tool_execution_end",
			toolCallId: "failed-report",
			toolName: "report_to_parent",
			isError: true,
			result: { content: [] },
		});
		expect(harness.overlay.definition.title(renderTheme)).not.toContain("unread");
		expect(await harness.handlers.get("context")?.({ messages: [] }, harness.ctx)).toBeUndefined();
	});

	test("transports report_to_parent events through a real RPC process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-subagent-report-rpc-"));
		const script = join(directory, "report-rpc.mjs");
		await writeFile(script, `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === "get_state") {
      process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true, data: { isStreaming: false } }) + "\\n");
    } else if (request.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "report-1",
          toolName: "report_to_parent",
          args: { message: "RPC mailbox update" }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "report-1",
          toolName: "report_to_parent",
          isError: false,
          result: { content: [] }
        }) + "\\n");
      }, 20);
    }
  }
});
setInterval(() => {}, 1000);
`, "utf8");
		const harness = createHarness({
			clientFactory: () => new RpcProcessClient({ command: process.execPath, args: [script], cwd: directory }),
		});
		try {
			const started = await spawnAgent(harness, "Exercise RPC reporting");
			const result = await harness.tool.execute("wait-rpc", {
				action: "wait",
				agent_names: [started.details.agents[0].name],
				timeout_ms: 1_000,
			}, undefined, undefined, harness.ctx);
			expect(result.details.mailbox).toMatchObject([{
				kind: "message",
				content: "RPC mailbox update",
			}]);
		} finally {
			await harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx);
			harnesses.splice(harnesses.indexOf(harness), 1);
			await rm(directory, { recursive: true, force: true });
		}
	}, 5_000);

	test("returns after a selected agent reports mailbox progress", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "Inspect API");
		const second = await spawnAgent(harness, "Inspect tests");
		const waitArgs = {
			reasoning: "Collect first useful update",
			action: "wait",
			agent_names: [first.details.agents[0].name, second.details.agents[0].name],
			timeout_ms: 1_000,
		};
		const waiting = harness.tool.execute("wait-message", waitArgs, undefined, undefined, harness.ctx);

		harness.clients[1].report("The renderer needs one edge-case test.");
		const result = await waiting;
		expect(result.details.timedOut).toBe(false);
		expect(result.details.agents.map((agent: any) => agent.status)).toEqual(["running", "running"]);
		expect(result.details.mailbox).toMatchObject([{
			kind: "message",
			agentName: second.details.agents[0].name,
			content: "The renderer needs one edge-case test.",
		}]);
		expect(result.content[0].text).toContain("<subagent_message>");
		expect(harness.sentMessages).toHaveLength(0);
		const lines = rendered(harness.tool.renderResult(result, { isPartial: false, expanded: false }, renderTheme, { args: waitArgs }));
		expect(lines.join("\n")).toContain(`${second.details.agents[0].name} · message`);
		expect(lines.join("\n")).toContain("The renderer needs one edge-case test.");
	});

	test("injects active-turn progress at the next model request boundary", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		const started = await spawnAgent(harness, "Inspect API");
		harness.clients[0].report("The API contract is stable.");
		await Bun.sleep(0);
		expect(harness.sentMessages).toHaveLength(0);

		const baseMessage = { role: "user", content: "Continue" };
		const boundary = await harness.handlers.get("context")?.({ messages: [baseMessage] }, harness.ctx);
		const delivery = boundary.messages.at(-1);
		expect(delivery).toMatchObject({
			role: "custom",
			customType: "subagent-mailbox",
			content: expect.stringContaining("The API contract is stable."),
			details: {
				action: "mailbox",
				agents: [],
				mailbox: [{ kind: "message", agentName: started.details.agents[0].name }],
			},
		});
		const renderer = harness.messageRenderers.get("subagent-mailbox")!;
		const lines = rendered(renderer(delivery, { expanded: false }, renderTheme));
		expect(lines[0]).toBe("• Agent mailbox");
		expect(lines.join("\n")).toContain("The API contract is stable.");
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		const laterMessage = { role: "assistant", content: [{ type: "text", text: "Tool work continues" }] };
		const nextBoundary = await harness.handlers.get("context")?.({ messages: [baseMessage, laterMessage] }, harness.ctx);
		expect(nextBoundary.messages[1]).toMatchObject({
			customType: "subagent-mailbox",
			content: expect.stringContaining("The API contract is stable."),
		});
		expect(nextBoundary.messages[2]).toBe(laterMessage);
		const history = [...harness.parent.getEntries()].reverse().find((entry: any) => entry.customType === "subagent-mailbox-history") as any;
		expect(history?.data?.details.mailbox[0].content).toBe("The API contract is stable.");
		const historyRenderer = harness.entryRenderers.get("subagent-mailbox-history")!;
		expect(rendered(historyRenderer(history, { expanded: false }, renderTheme)).join("\n")).toContain("The API contract is stable.");
	});

	test("reports coalesced progress omissions to parent context", async () => {
		const harness = createHarness({
			config: {
				wait: { minimumMs: 0, defaultMs: 300_000, maximumMs: 3_600_000 },
				mailbox: { maxMessageBytes: 8 * 1024, maxMessagesPerAgent: 1 },
			},
		});
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await spawnAgent(harness, "Report repeated progress");
		harness.clients[0].report("First progress");
		harness.clients[0].report("Latest progress");
		const boundary = await harness.handlers.get("context")?.({ messages: [] }, harness.ctx);
		const delivery = boundary.messages.at(-1);
		expect(delivery.content).toContain("Earlier updates omitted: 1");
		expect(delivery.content).toContain("Latest progress");
		expect(delivery.content).not.toContain("First progress");
		harness.clients[0].report("Newest progress");
		const nextBoundary = await harness.handlers.get("context")?.({ messages: [] }, harness.ctx);
		const retained = nextBoundary.messages.at(-1);
		expect(retained.content).toContain("Earlier updates omitted: 2");
		expect(retained.content).toContain("Newest progress");
		expect(Buffer.byteLength(retained.content)).toBeLessThanOrEqual(48 * 1024);
		await harness.commands.get("agents").handler("", {
			...harness.ctx,
			ui: { ...harness.ctx.ui, select: async (_title: string, labels: string[]) => labels[0] },
		});
		expect(harness.notifications.at(-1)).toContain("1 coalesced");
	});

	test("recovers unread final results from durable session state", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		const started = await spawnAgent(harness, "Inspect recovery");
		harness.clients[0].complete("Durable final result");
		await Bun.sleep(0);
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.parent.getEntries().some((entry: any) => entry.customType === "subagent-mailbox-state" && entry.data?.state === "unread")).toBe(true);

		await harness.handlers.get("session_start")?.({ reason: "resume" }, harness.ctx);
		await Bun.sleep(0);
		expect(harness.sentMessages.at(-1)).toMatchObject({
			message: {
				customType: "subagent-result",
				content: expect.stringContaining("Durable final result"),
				details: { name: started.details.agents[0].name, output: "Durable final result" },
			},
			options: { triggerTurn: false },
		});
		expect(harness.parent.getEntries().some((entry: any) => entry.customType === "subagent-mailbox-state" && entry.data?.state === "delivered")).toBe(true);
	});

	test("renders two active-turn final results as monochrome Markdown blocks", async () => {
		const harness = createHarness();
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		const first = await spawnAgent(harness, "Inspect API");
		const second = await spawnAgent(harness, "Inspect accessibility");
		harness.clients[0].complete("**API review complete with `client.ts`.**");
		harness.clients[1].complete("[Accessibility review](https://www.w3.org/WAI/) complete.");
		await Bun.sleep(0);
		expect(harness.sentMessages).toHaveLength(0);

		const boundary = await harness.handlers.get("context")?.({ messages: [] }, harness.ctx);
		const delivery = boundary.messages.at(-1);
		expect(delivery.details.agents).toMatchObject([
			{ name: first.details.agents[0].name, status: "completed", output: "**API review complete with `client.ts`.**" },
			{ name: second.details.agents[0].name, status: "completed", output: "[Accessibility review](https://www.w3.org/WAI/) complete." },
		]);
		const renderer = harness.messageRenderers.get("subagent-mailbox")!;
		const lines = rendered(renderer(delivery, { expanded: false }, renderTheme));
		const output = lines.join("\n");
		expect(lines[0]).toBe("• Agent mailbox · 2 completed");
		expect(lines[2]).toContain(`✓ ${first.details.agents[0].name}`);
		expect(lines[2]).not.toContain("context");
		expect(lines[10]).toContain(`✓ ${second.details.agents[0].name}`);
		expect(lines[10]).not.toContain("context");
		expect(output).toContain("API review complete with client.ts.");
		expect(output).toContain("Accessibility review");
		expect(output).not.toContain("**");
		expect(output).not.toContain("](");

		const styled = renderer(delivery, { expanded: true }, semanticTheme).render(100);
		for (const resultLine of [styled[6], styled[14]]) {
			const foregrounds = [...resultLine.matchAll(/\x1b\[(3\d|9\d)m/g)].map((match) => match[1]);
			expect(new Set(foregrounds)).toEqual(new Set(["37"]));
		}
	});

	test("waits for all selected agents while retaining interim updates", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "First task");
		const second = await spawnAgent(harness, "Second task");
		const waiting = harness.tool.execute("wait", {
			action: "wait",
			agent_names: [first.details.agents[0].name, second.details.agents[0].name],
			return_when: "all",
			timeout_ms: 1_000,
		}, undefined, undefined, harness.ctx);
		harness.clients[0].report("First interim update");
		setTimeout(() => {
			harness.clients[0].complete("First result");
			harness.clients[1].complete("Second result");
		}, 5);
		const result = await waiting;
		expect(result.content[0].text).toContain("First interim update");
		expect(result.content[0].text).toContain("First result");
		expect(result.content[0].text).toContain("Second result");
		expect(result.details.mailbox).toContainEqual(expect.objectContaining({ kind: "message", content: "First interim update" }));
		expect(result.details.timedOut).toBe(false);
		expect(harness.sentMessages).toHaveLength(0);
	});

	test("final-only waits retain progress without waking early", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Inspect API");
		let returned = false;
		const waiting = harness.tool.execute("wait-final", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
			wake_on: "final",
			timeout_ms: 1_000,
		}, undefined, undefined, harness.ctx).then((result: any) => {
			returned = true;
			return result;
		});
		harness.clients[0].report("Interim only");
		await Bun.sleep(0);
		expect(returned).toBe(false);
		harness.clients[0].complete("Final result");
		const result = await waiting;
		expect(result.content[0].text).toContain("Interim only");
		expect(result.content[0].text).toContain("Final result");
	});

	test("rejects overlapping waits on the same active child", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Single waiter");
		const args = { action: "wait", agent_names: [started.details.agents[0].name], timeout_ms: 1_000 };
		const first = harness.tool.execute("wait-first", { ...args, wake_on: "final" }, undefined, undefined, harness.ctx);
		harness.clients[0].report("Queued for the existing final-only wait");
		await expect(harness.tool.execute("wait-second", args, undefined, undefined, harness.ctx)).rejects.toThrow("already has an active wait");
		harness.clients[0].complete("Done");
		await first;
	});

	test("interrupts waits without cancelling child work", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Keep working");
		const controller = new AbortController();
		const waiting = harness.tool.execute("wait-abort", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
			timeout_ms: 1_000,
		}, controller.signal, undefined, harness.ctx);
		controller.abort();
		const result = await waiting;
		expect(result.details).toMatchObject({ interrupted: true, timedOut: false });
		expect(result.content[0].text).toContain("Wait interrupted by new input or cancellation");
		expect(result.details.agents[0].status).toBe("running");
		expect(harness.clients[0].abortCalls).toBe(0);
	});

	test("uses configured wait defaults and bounds", async () => {
		const harness = createHarness({
			config: {
				wait: { minimumMs: 0, defaultMs: 0, maximumMs: 10 },
				mailbox: { maxMessageBytes: 8 * 1024, maxMessagesPerAgent: 2 },
			},
		});
		const started = await spawnAgent(harness, "Inspect timeout config");
		expect(harness.tool.parameters.properties.timeout_ms).toMatchObject({ minimum: 0, maximum: 10 });
		const result = await harness.tool.execute("configured-timeout", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
		}, undefined, undefined, harness.ctx);
		expect(result.details.timedOut).toBe(true);
		await expect(harness.tool.execute("too-long", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
			timeout_ms: 11,
		}, undefined, undefined, harness.ctx)).rejects.toThrow("between 0 and 10");
	});

	test("returns after any selected agent settles by default", async () => {
		const harness = createHarness();
		const first = await spawnAgent(harness, "First task");
		const second = await spawnAgent(harness, "Second task");
		const waiting = harness.tool.execute("wait-any", {
			action: "wait",
			agent_names: [first.details.agents[0].name, second.details.agents[0].name],
			timeout_ms: 1_000,
		}, undefined, undefined, harness.ctx);

		harness.clients[0].complete("First result");
		const result = await waiting;
		expect(result.details.timedOut).toBe(false);
		expect(result.details.agents.map((agent: any) => agent.status)).toEqual(["completed", "running"]);
		expect(result.content[0].text).toContain("First result");
		expect(result.content[0].text).toContain("(still running)");
		expect(harness.sentMessages).toHaveLength(0);

		harness.clients[1].complete("Second result");
		await Bun.sleep(0);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.content).toContain("Second result");
	});

	test("rejects invalid wait completion conditions, wake filters, and excessive timeouts", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Inspect wait validation");
		await expect(harness.tool.execute("invalid-wait", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
			return_when: "first",
			timeout_ms: 0,
		}, undefined, undefined, harness.ctx)).rejects.toThrow("return_when must be any or all");
		await expect(harness.tool.execute("invalid-wake", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
			wake_on: "message",
			timeout_ms: 0,
		}, undefined, undefined, harness.ctx)).rejects.toThrow("wake_on must be any or final");
		await expect(harness.tool.execute("invalid-timeout", {
			action: "wait",
			agent_names: [started.details.agents[0].name],
			timeout_ms: 3_600_001,
		}, undefined, undefined, harness.ctx)).rejects.toThrow("between 0 and 3600000");
	});

	test("separates queue-only messages from turn-triggering follow-ups", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Inspect API");
		const name = started.details.agents[0].name;
		await harness.tool.execute("message-running", {
			action: "message", agent_name: name, message: "Remember the compatibility note",
		}, undefined, undefined, harness.ctx);
		expect(harness.clients[0].steering).toEqual(["Remember the compatibility note"]);

		harness.clients[0].complete("Initial result");
		await Bun.sleep(0);
		const queued = await harness.tool.execute("message-idle", {
			action: "message", agent_name: name, message: "Use the stable API",
		}, undefined, undefined, harness.ctx);
		expect(queued.content[0].text).toContain("without starting a turn");
		expect(harness.clients).toHaveLength(1);

		await harness.tool.execute("followup-idle", {
			action: "followup", agent_name: name, message: "Now inspect the renderer",
		}, undefined, undefined, harness.ctx);
		expect(harness.clients).toHaveLength(2);
		expect(harness.clients[1].prompts[0]).toContain("Queued message:\nUse the stable API");
		expect(harness.clients[1].prompts[0]).toContain("Follow-up task:\nNow inspect the renderer");
	});

	test("rejects queue overflow instead of silently dropping context", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Inspect queued context");
		const name = started.details.agents[0].name;
		harness.clients[0].complete("Initial result");
		await Bun.sleep(0);
		for (let index = 0; index < 4; index += 1) {
			await harness.tool.execute(`message-${index}`, { action: "message", agent_name: name, message: `Context ${index}` }, undefined, undefined, harness.ctx);
		}
		await expect(harness.tool.execute("message-overflow", {
			action: "message", agent_name: name, message: "Context 4",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("already has 4 queued messages");
	});

	test("serializes concurrent resumptions while child startup settles", async () => {
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
		let created = 0;
		const clients: FakeClient[] = [];
		const harness = createHarness({
			clientFactory: (options) => {
				const client = new FakeClient(options);
				created += 1;
				if (created === 2) client.start = async () => { await startGate; client.started = true; };
				clients.push(client);
				return client;
			},
		});
		const started = await spawnAgent(harness, "Resume once");
		const name = started.details.agents[0].name;
		clients[0].complete("Initial result");
		await Bun.sleep(0);
		const first = harness.tool.execute("followup-first", { action: "followup", agent_name: name, message: "First" }, undefined, undefined, harness.ctx);
		const second = harness.tool.execute("followup-second", {
			action: "followup", agent_name: name, message: "Second",
		}, undefined, undefined, harness.ctx);
		await Bun.sleep(0);
		expect(clients).toHaveLength(2);
		expect(clients[1].prompts).toHaveLength(0);
		expect(clients[1].steering).toHaveLength(0);
		releaseStart();
		await Promise.all([first, second]);
		expect(clients[1].prompts).toEqual(["First"]);
		expect(clients[1].steering).toEqual(["Second"]);
	});

	test("serializes concurrent send, followup, and message dispatch", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Process ordered instructions");
		const name = started.details.agents[0].name;
		const client = harness.clients[0];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let inFlight = 0;
		let maxInFlight = 0;
		client.steer = async (message) => {
			client.steering.push(message);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (message === "First") await firstGate;
			inFlight -= 1;
		};

		const first = harness.tool.execute("send-first", { action: "send", agent_name: name, message: "First" }, undefined, undefined, harness.ctx);
		const second = harness.tool.execute("followup-second", { action: "followup", agent_name: name, message: "Second" }, undefined, undefined, harness.ctx);
		const third = harness.tool.execute("message-third", { action: "message", agent_name: name, message: "Third" }, undefined, undefined, harness.ctx);
		await Bun.sleep(0);
		expect(client.steering).toEqual(["First"]);
		expect(inFlight).toBe(1);
		releaseFirst();
		await Promise.all([first, second, third]);
		expect(client.steering).toEqual(["First", "Second", "Third"]);
		expect(maxInFlight).toBe(1);
	});

	test("does not let a rejected send roll back a newer followup", async () => {
		let rejectPrompt!: (error: Error) => void;
		const promptGate = new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		let created = 0;
		const clients: FakeClient[] = [];
		const harness = createHarness({
			clientFactory: (options) => {
				const client = new FakeClient(options);
				created += 1;
				if (created === 2) {
					client.prompt = async (message) => {
						client.prompts.push(message);
						await promptGate;
					};
				}
				clients.push(client);
				return client;
			},
		});
		const started = await spawnAgent(harness, "Reject one resume");
		const name = started.details.agents[0].name;
		clients[0].complete("Initial result");
		await Bun.sleep(0);

		const rejected = harness.tool.execute("send-rejected", {
			action: "send", agent_name: name, message: "Rejected older instruction",
		}, undefined, undefined, harness.ctx).then(() => undefined, (error: Error) => error);
		await Bun.sleep(0);
		expect(clients[1].prompts).toEqual(["Rejected older instruction"]);
		const accepted = harness.tool.execute("followup-accepted", {
			action: "followup", agent_name: name, message: "Accepted newer instruction",
		}, undefined, undefined, harness.ctx);
		await Bun.sleep(0);
		expect(clients).toHaveLength(2);
		expect(clients[1].steering).toHaveLength(0);

		rejectPrompt(new Error("prompt rejected"));
		expect((await rejected)?.message).toBe("prompt rejected");
		await accepted;
		expect(clients[1].stopped).toBe(true);
		expect(clients).toHaveLength(3);
		expect(clients[2].prompts).toEqual(["Accepted newer instruction"]);
		const listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "running", output: "", error: undefined });
	});

	test("keeps a concurrent message queue-only after a rejected followup", async () => {
		let rejectPrompt!: (error: Error) => void;
		const promptGate = new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
		let created = 0;
		const clients: FakeClient[] = [];
		const harness = createHarness({
			clientFactory: (options) => {
				const client = new FakeClient(options);
				created += 1;
				if (created === 2) {
					client.prompt = async (message) => {
						client.prompts.push(message);
						await promptGate;
					};
				}
				clients.push(client);
				return client;
			},
		});
		const started = await spawnAgent(harness, "Preserve queued context");
		const name = started.details.agents[0].name;
		clients[0].complete("Initial result");
		await Bun.sleep(0);

		const rejected = harness.tool.execute("followup-rejected", {
			action: "followup", agent_name: name, message: "Rejected turn",
		}, undefined, undefined, harness.ctx).then(() => undefined, (error: Error) => error);
		await Bun.sleep(0);
		const queued = harness.tool.execute("message-queued", {
			action: "message", agent_name: name, message: "Retained queue-only context",
		}, undefined, undefined, harness.ctx);
		rejectPrompt(new Error("prompt rejected"));
		expect((await rejected)?.message).toBe("prompt rejected");
		expect((await queued).content[0].text).toContain("without starting a turn");
		expect(clients).toHaveLength(2);
		expect(clients[1].stopped).toBe(true);

		const listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "completed", output: "Initial result" });
		await harness.tool.execute("followup-after-queue", {
			action: "followup", agent_name: name, message: "Use retained context",
		}, undefined, undefined, harness.ctx);
		expect(clients[2].prompts[0]).toContain("Queued message:\nRetained queue-only context");
		expect(clients[2].prompts[0]).toContain("Follow-up task:\nUse retained context");
	});

	test("keeps send as a legacy follow-up alias", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness);
		const name = started.details.agents[0].name;
		await harness.tool.execute("send-running", { action: "send", agent_name: name, message: "Focus on tests" }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].steering).toEqual(["Focus on tests"]);
		expect(harness.overlay.definition.renderBody(54, 6, renderTheme)[2]).toContain("follow-up: Focus on tests");
		const originalSession = harness.clients[0].options.args[harness.clients[0].options.args.indexOf("--session") + 1];
		harness.clients[0].complete("Initial result");
		await harness.tool.execute("send-idle", { action: "send", agent_name: name, message: "Now inspect docs" }, undefined, undefined, harness.ctx);
		expect(harness.clients[0].stopped).toBe(true);
		expect(harness.clients).toHaveLength(2);
		expect(harness.clients[1].started).toBe(true);
		expect(harness.clients[1].prompts.at(-1)).toBe("Now inspect docs");
		expect(harness.clients[1].options.args[harness.clients[1].options.args.indexOf("--session") + 1]).toBe(originalSession);
		expect(harness.overlay.definition.renderBody(54, 6, renderTheme)[2]).toContain("follow-up: Now inspect");
	});

	test("reads a hibernated agent response without restarting it", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Produce a reusable result");
		const name = started.details.agents[0].name;
		harness.clients[0].complete("Reusable final response");
		await Bun.sleep(0);
		const args = { reasoning: "Recall delegated result", action: "read", agent_name: name };
		const result = await harness.tool.execute("read", args, undefined, undefined, harness.ctx);
		expect(result.content[0].text).toContain("Reusable final response");
		expect(result.details.agents[0]).toMatchObject({ status: "completed", output: "Reusable final response" });
		const lines = rendered(harness.tool.renderResult(result, { isPartial: false, expanded: false }, renderTheme, { args }));
		expect(lines[0]).toBe(`• Read agent ${name} to Recall delegated result`);
		expect(lines).toContain("    Result");
		expect(lines).toContain("    Reusable final response");
		expect(harness.clients).toHaveLength(1);
		expect(harness.clients[0].stopped).toBe(true);
	});

	test("interrupts a running child and resumes its retained session", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness, "Long-running investigation");
		const name = started.details.agents[0].name;
		const originalSession = harness.clients[0].options.args[harness.clients[0].options.args.indexOf("--session") + 1];
		const args = { reasoning: "Stop broad investigation", action: "interrupt", agent_name: name };
		const interrupted = await harness.tool.execute("interrupt", args, undefined, undefined, harness.ctx);
		expect(interrupted.details.agents[0].status).toBe("interrupted");
		const lines = rendered(harness.tool.renderResult(interrupted, { isPartial: false, expanded: false }, renderTheme, { args }));
		expect(lines[0]).toBe(`• Interrupted agent ${name} to Stop broad investigation`);
		expect(lines[1]).toBe("    Task    Long-running investigation");
		expect(harness.clients[0].abortCalls).toBe(1);
		expect(harness.clients[0].stopped).toBe(true);
		expect(existsSync(originalSession)).toBe(true);
		expect(harness.sentMessages).toHaveLength(0);

		await harness.tool.execute("resume", { action: "send", agent_name: name, message: "Continue with a narrower scope" }, undefined, undefined, harness.ctx);
		expect(harness.clients).toHaveLength(2);
		expect(harness.clients[1].prompts).toEqual(["Continue with a narrower scope"]);
		expect(harness.clients[1].options.args[harness.clients[1].options.args.indexOf("--session") + 1]).toBe(originalSession);
	});

	test("preserves child state when steer or follow-up dispatch is rejected", async () => {
		let releaseResume!: () => void;
		const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
		const clients: FakeClient[] = [];
		const harness = createHarness({
			clientFactory: (options) => {
				const client = new FakeClient(options);
				clients.push(client);
				if (clients.length === 2) client.start = async () => { await resumeGate; client.started = true; };
				return client;
			},
		});
		const started = await spawnAgent(harness);
		const name = started.details.agents[0].name;
		clients[0].steerError = new Error("not streaming");
		await expect(harness.tool.execute("send-running", {
			action: "send", agent_name: name, message: "Race with completion",
		}, undefined, undefined, harness.ctx)).rejects.toThrow("not streaming");
		let listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "running", error: undefined });

		clients[0].steerError = undefined;
		clients[0].complete("Initial result");
		await Bun.sleep(0);
		const notificationCount = harness.sentMessages.length;
		const rejectedFollowUp = harness.tool.execute("send-idle", {
			action: "send", agent_name: name, message: "Rejected follow-up",
		}, undefined, undefined, harness.ctx);
		await Bun.sleep(0);
		expect(clients).toHaveLength(2);
		clients[1].promptError = new Error("prompt rejected");
		releaseResume();
		await expect(rejectedFollowUp).rejects.toThrow("prompt rejected");
		await Bun.sleep(0);
		listed = await harness.tool.execute("list", { action: "list" }, undefined, undefined, harness.ctx);
		expect(listed.details.agents[0]).toMatchObject({ status: "completed", error: undefined, output: "Initial result" });
		expect(harness.sentMessages).toHaveLength(notificationCount);
	});

	test("enforces the conversation limit until a hibernated child is closed", async () => {
		const harness = createHarness({ maxAgents: 2 });
		const first = await spawnAgent(harness, "First");
		const sessionFile = harness.clients[0].options.args[harness.clients[0].options.args.indexOf("--session") + 1];
		await spawnAgent(harness, "Second");
		harness.clients[0].complete("First complete");
		await Bun.sleep(0);
		expect(harness.clients[0].stopped).toBe(true);
		expect(existsSync(sessionFile)).toBe(true);
		await expect(spawnAgent(harness, "Third")).rejects.toThrow("At most 2 subagents");
		await harness.tool.execute("close", { action: "close", agent_name: first.details.agents[0].name }, undefined, undefined, harness.ctx);
		expect(existsSync(sessionFile)).toBe(false);
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

	test("checkpoints active children across reload and restores them hibernated", async () => {
		const first = createHarness();
		const started = await spawnAgent(first, "Survive extension reload");
		const name = started.details.agents[0].name;
		const sessionFile = first.clients[0].options.args[first.clients[0].options.args.indexOf("--session") + 1];
		expect(sessionFile.startsWith(first.storageRoot)).toBe(true);

		await first.handlers.get("session_shutdown")?.({ reason: "reload" }, first.ctx);
		expect(first.clients[0].abortCalls).toBe(1);
		expect(first.clients[0].stopped).toBe(true);
		expect(existsSync(sessionFile)).toBe(true);
		expect(first.parent.getEntries().some((entry: any) =>
			entry.customType === "subagent-state"
			&& entry.data?.state === "open"
			&& entry.data?.agent?.name === name
			&& entry.data?.agent?.status === "paused",
		)).toBe(true);
		harnesses.splice(harnesses.indexOf(first), 1);

		const restored = createHarness({ parent: first.parent, storageRoot: first.storageRoot });
		let listed = await restored.tool.execute("list-restored", { action: "list" }, undefined, undefined, restored.ctx);
		expect(listed.details.agents).toMatchObject([{ name, status: "paused" }]);
		expect(restored.clients).toHaveLength(0);
		await restored.tool.execute("resume-restored", {
			action: "followup",
			agent_name: name,
			message: "Continue after reload",
		}, undefined, undefined, restored.ctx);
		expect(restored.clients).toHaveLength(1);
		expect(restored.clients[0].options.args[restored.clients[0].options.args.indexOf("--session") + 1]).toBe(sessionFile);
		expect(restored.clients[0].prompts).toEqual(["Continue after reload"]);

		await restored.tool.execute("close-restored", { action: "close", agent_name: name }, undefined, undefined, restored.ctx);
		expect(existsSync(sessionFile)).toBe(false);
		expect(restored.parent.getEntries().some((entry: any) =>
			entry.customType === "subagent-state" && entry.data?.id === started.details.agents[0].id && entry.data?.state === "closed",
		)).toBe(true);
		await restored.handlers.get("session_shutdown")?.({ reason: "reload" }, restored.ctx);
		harnesses.splice(harnesses.indexOf(restored), 1);

		const afterClose = createHarness({ parent: first.parent, storageRoot: first.storageRoot });
		listed = await afterClose.tool.execute("list-after-close", { action: "list" }, undefined, undefined, afterClose.ctx);
		expect(listed.details.agents).toEqual([]);
	});

	test("restores settled children and queued context after parent quit", async () => {
		const first = createHarness();
		const started = await spawnAgent(first, "Retain completed review");
		const name = started.details.agents[0].name;
		first.clients[0].complete("Completed result before quit");
		await Bun.sleep(0);
		await first.tool.execute("queue-before-quit", {
			action: "message",
			agent_name: name,
			message: "Queued context before quit",
		}, undefined, undefined, first.ctx);
		await first.handlers.get("session_shutdown")?.({ reason: "quit" }, first.ctx);
		harnesses.splice(harnesses.indexOf(first), 1);

		const restored = createHarness({ parent: first.parent, storageRoot: first.storageRoot });
		const read = await restored.tool.execute("read-after-quit", { action: "read", agent_name: name }, undefined, undefined, restored.ctx);
		expect(read.details.agents[0]).toMatchObject({ status: "completed", output: "Completed result before quit" });
		expect(restored.clients).toHaveLength(0);
		await restored.tool.execute("followup-after-quit", {
			action: "followup",
			agent_name: name,
			message: "Resume after quit",
		}, undefined, undefined, restored.ctx);
		expect(restored.clients[0].prompts[0]).toContain("Queued message:\nQueued context before quit");
		expect(restored.clients[0].prompts[0]).toContain("Follow-up task:\nResume after quit");
	});

	test("retains child context after an unexpected RPC process exit", async () => {
		const crashed = createHarness();
		const started = await spawnAgent(crashed, "Recover from child process exit");
		const name = started.details.agents[0].name;
		const sessionFile = crashed.clients[0].options.args[crashed.clients[0].options.args.indexOf("--session") + 1];
		crashed.clients[0].exit(new Error("RPC process crashed"));
		await Bun.sleep(0);
		let failed = await crashed.tool.execute("list-crashed", { action: "list" }, undefined, undefined, crashed.ctx);
		expect(failed.details.agents[0]).toMatchObject({ status: "failed", error: "RPC process crashed" });
		expect(existsSync(sessionFile)).toBe(true);
		harnesses.splice(harnesses.indexOf(crashed), 1);

		const restored = createHarness({ parent: crashed.parent, storageRoot: crashed.storageRoot });
		failed = await restored.tool.execute("list-restored-crash", { action: "list" }, undefined, undefined, restored.ctx);
		expect(failed.details.agents[0]).toMatchObject({ name, status: "failed", error: "RPC process crashed" });
		await restored.tool.execute("resume-crashed", {
			action: "followup",
			agent_name: name,
			message: "Resume from the retained session",
		}, undefined, undefined, restored.ctx);
		expect(restored.clients).toHaveLength(1);
		expect(restored.clients[0].options.args[restored.clients[0].options.args.indexOf("--session") + 1]).toBe(sessionFile);
	});

	test("cancels a spawn that outlives parent session shutdown", async () => {
		let releaseContext!: () => void;
		const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
		const harness = createHarness({
			forkContext: async (ctx, mode, compactedSummary) => {
				await contextGate;
				return createContextFork(ctx, mode, compactedSummary);
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

	test("retries close after hibernation fails and still clears live UI", async () => {
		const harness = createHarness();
		const started = await spawnAgent(harness);
		const name = started.details.agents[0].name;
		harness.clients[0].stopError = new Error("stop failed");
		harness.clients[0].complete("Completed before stop failure");
		await Bun.sleep(0);
		await expect(harness.tool.execute("close", { action: "close", agent_name: name }, undefined, undefined, harness.ctx)).rejects.toThrow("stop failed");
		expect(harness.overlay.definition.visible()).toBe(false);
		expect(harness.statuses.size).toBe(0);
		expect(harness.clients[0].stopped).toBe(false);
		harness.clients[0].stopError = undefined;
		await expect(harness.tool.execute("close", { action: "close", agent_name: name }, undefined, undefined, harness.ctx)).resolves.toBeDefined();
		expect(harness.clients[0].stopped).toBe(true);
	});

	test("finishes shutdown cleanup when one child stop fails", async () => {
		const harness = createHarness();
		await spawnAgent(harness, "First shutdown task");
		await spawnAgent(harness, "Second shutdown task");
		harness.clients[0].stopError = new Error("first stop failed");
		await expect(harness.handlers.get("session_shutdown")?.({ reason: "quit" }, harness.ctx)).rejects.toThrow("Failed to checkpoint");
		expect(harness.clients[1].stopped).toBe(true);
		expect(harness.overlay.unregistered).toBe(true);
		expect(harness.statuses.size).toBe(0);
	});

	test("bounds aggregate model-visible output", async () => {
		const result = boundedText("x".repeat(100_000), 2_000);
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(2_000);
		expect(result).toContain("output omitted");

		const harness = createHarness();
		const first = await spawnAgent(harness, "Large first result");
		const second = await spawnAgent(harness, "Large second result");
		const waiting = harness.tool.execute("wait-large", {
			action: "wait",
			agent_names: [first.details.agents[0].name, second.details.agents[0].name],
			return_when: "all",
			timeout_ms: 1_000,
		}, undefined, undefined, harness.ctx);
		for (const client of harness.clients) {
			for (let index = 0; index < 4; index += 1) client.report(`${index}:` + "m".repeat(3_900), `report-${index}`);
			client.complete("r".repeat(24 * 1024));
		}
		const waited = await waiting;
		expect(Buffer.byteLength(waited.content[0].text)).toBeLessThanOrEqual(48 * 1024);
		expect(waited.content[0].text).toContain("output omitted");
	});
});
