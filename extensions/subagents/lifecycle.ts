import type { ContextFork, ContextMode } from "./context.js";
import type { AgentClient, AgentClientFactory, AgentClientOptions, RpcAgentEvent } from "./rpc.js";

export const RESULT_BYTES = 24 * 1024;

export type AgentStatus = "starting" | "running" | "completed" | "failed" | "interrupted" | "closed";

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface AgentSnapshot {
	id: string;
	name?: string;
	task: string;
	contextMode: ContextMode;
	status: AgentStatus;
	cwd: string;
	model?: string;
	startedAt: number;
	endedAt?: number;
	output: string;
	error?: string;
	activity: string[];
	usage: AgentUsage;
}

export interface ManagedAgent extends AgentSnapshot {
	client?: AgentClient;
	clientOptions: AgentClientOptions;
	fork: ContextFork;
	completion: Promise<void>;
	resolveCompletion: () => void;
	runSettled: boolean;
	waiting: number;
	queuedMessages: string[];
	pendingReports: Map<string, string>;
	completionDelivery: "none" | "automatic" | "wait";
	suppressNotifications: boolean;
	generation: number;
	cleanupComplete: boolean;
	hibernatePromise?: Promise<void>;
	resumePromise?: Promise<AgentClient>;
	closePromise?: Promise<void>;
	transitioning: boolean;
}

export function isAgentSnapshot(value: unknown): value is AgentSnapshot {
	if (!value || typeof value !== "object") return false;
	const agent = value as Record<string, unknown>;
	const usage = agent.usage as Record<string, unknown> | undefined;
	return typeof agent.id === "string"
		&& (agent.name === undefined || typeof agent.name === "string")
		&& typeof agent.task === "string"
		&& (["fresh", "compacted", "forked"] as unknown[]).includes(agent.contextMode)
		&& (["starting", "running", "completed", "failed", "interrupted", "closed"] as unknown[]).includes(agent.status)
		&& typeof agent.cwd === "string"
		&& (agent.model === undefined || typeof agent.model === "string")
		&& typeof agent.startedAt === "number"
		&& (agent.endedAt === undefined || typeof agent.endedAt === "number")
		&& typeof agent.output === "string"
		&& (agent.error === undefined || typeof agent.error === "string")
		&& Array.isArray(agent.activity)
		&& agent.activity.every((item) => typeof item === "string")
		&& Boolean(usage)
		&& [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.cost, usage?.turns].every((item) => typeof item === "number");
}

export function sanitizeTerminal(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function compact(text: string, limit = 100): string {
	const oneLine = sanitizeTerminal(text).replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

export function boundedInput(value: unknown, label: string, maxChars: number): string {
	const text = String(value ?? "").trim();
	if (!text) throw new Error(`${label} requires non-empty text`);
	if (text.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
	return text;
}

export function normalizeAgentName(value: unknown, maxChars: number): string {
	if (typeof value !== "string") throw new Error("spawn requires an agent name");
	const name = sanitizeTerminal(value).replace(/\s+/g, " ").trim();
	if (!name) throw new Error("spawn requires an agent name");
	if (name.length > maxChars) throw new Error(`agent name must be at most ${maxChars} characters`);
	return name;
}

export function agentNameKey(name: string): string {
	return name.toLowerCase();
}

export function boundedText(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const marker = "\n\n[... output omitted ...]\n\n";
	const available = Math.max(0, maxBytes - Buffer.byteLength(marker));
	let head = text.slice(0, Math.floor(available / 3));
	let tail = text.slice(-Math.ceil(available * 2 / 3));
	while (Buffer.byteLength(head + marker + tail) > maxBytes && tail.length > 0) tail = tail.slice(1);
	while (Buffer.byteLength(head + marker + tail) > maxBytes && head.length > 0) head = head.slice(0, -1);
	return head + marker + tail;
}

export function isActive(agent: Pick<ManagedAgent, "status">): boolean {
	return agent.status === "starting" || agent.status === "running";
}

export function extractAssistantText(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return sanitizeTerminal(message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim());
}

export function resetCompletion(agent: ManagedAgent): void {
	agent.runSettled = false;
	agent.completion = new Promise<void>((resolve) => { agent.resolveCompletion = resolve; });
}

export function toAgentSnapshot(agent: ManagedAgent): AgentSnapshot {
	return {
		id: agent.id,
		name: agent.name,
		task: agent.task,
		contextMode: agent.contextMode,
		status: agent.status,
		cwd: agent.cwd,
		model: agent.model,
		startedAt: agent.startedAt,
		endedAt: agent.endedAt,
		output: boundedText(agent.output, RESULT_BYTES),
		error: agent.error,
		activity: [...agent.activity],
		usage: { ...agent.usage },
	};
}

export interface AgentLifecycleOptions {
	createClient: AgentClientFactory;
	reportToolName: string;
	maxReportChars: number;
	assertCurrentSession(expectedGeneration: number): void;
	publishMailboxEvent(agent: ManagedAgent, kind: "message" | "final", content: string): void;
	discardMailboxEvents(agent: ManagedAgent): void;
	recordUsage(agent: ManagedAgent, message: any): void;
	updateOverlay(): void;
	refreshTranscript(): void;
	trimClosed(): void;
}

export function createAgentLifecycle(options: AgentLifecycleOptions) {
	const hibernateAgent = async (agent: ManagedAgent): Promise<void> => {
		if (agent.hibernatePromise) return agent.hibernatePromise;
		const client = agent.client;
		if (!client) return;
		const operation = (async () => {
			await client.stop();
			if (agent.client === client) agent.client = undefined;
			options.updateOverlay();
		})();
		agent.hibernatePromise = operation;
		try {
			await operation;
		} finally {
			if (agent.hibernatePromise === operation) agent.hibernatePromise = undefined;
		}
	};

	const finishRun = (agent: ManagedAgent, status: "completed" | "failed", error?: string): void => {
		if (agent.runSettled || agent.status === "closed") return;
		agent.runSettled = true;
		agent.status = status;
		agent.endedAt = Date.now();
		if (error) agent.error = boundedText(sanitizeTerminal(error), 4 * 1024);
		options.publishMailboxEvent(agent, "final", agent.error || agent.output || "(no final text)");
		agent.resolveCompletion();
		options.updateOverlay();
		void hibernateAgent(agent).catch((hibernateError) => {
			agent.activity.push(`hibernate failed: ${compact(hibernateError instanceof Error ? hibernateError.message : String(hibernateError), 100)}`);
			if (agent.activity.length > 12) agent.activity.shift();
			options.updateOverlay();
		});
	};

	const handleEvent = (agent: ManagedAgent, event: RpcAgentEvent): void => {
		if (agent.status === "closed") return;
		if (event.type === "agent_start") {
			agent.status = "running";
			options.updateOverlay();
			return;
		}
		if (event.type === "tool_execution_start") {
			if (event.toolName === options.reportToolName) {
				const message = boundedText(sanitizeTerminal(String(event.args?.message ?? "").trim()), options.maxReportChars);
				const callId = String(event.toolCallId ?? "");
				if (message && callId) agent.pendingReports.set(callId, message);
				else if (message) options.publishMailboxEvent(agent, "message", message);
			}
			const detail = event.args?.command ?? (event.toolName === options.reportToolName ? event.args?.message : undefined);
			const description = `${event.toolName ?? "tool"}${detail ? `: ${compact(String(detail), 100)}` : ""}`;
			agent.activity.push(description);
			if (agent.activity.length > 12) agent.activity.shift();
			options.updateOverlay();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName === options.reportToolName) {
			const callId = String(event.toolCallId ?? "");
			const message = agent.pendingReports.get(callId);
			agent.pendingReports.delete(callId);
			if (message && !event.isError) options.publishMailboxEvent(agent, "message", message);
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			agent.output = boundedText(extractAssistantText(event.message), RESULT_BYTES);
			agent.usage.turns += 1;
			const usage = event.message.usage;
			if (usage) {
				agent.usage.input += usage.input || 0;
				agent.usage.output += usage.output || 0;
				agent.usage.cacheRead += usage.cacheRead || 0;
				agent.usage.cacheWrite += usage.cacheWrite || 0;
				agent.usage.cost += usage.cost?.total || 0;
			}
			options.recordUsage(agent, event.message);
			if (event.message.provider && event.message.model) agent.model = `${event.message.provider}/${event.message.model}`;
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				const message = event.message.errorMessage || `Agent ${event.message.stopReason}`;
				agent.error = boundedText(sanitizeTerminal(message), 4 * 1024);
			} else agent.error = undefined;
			return;
		}
		if (event.type === "extension_error") {
			agent.activity.push(`extension error: ${event.error ?? "unknown"}`);
			if (agent.activity.length > 12) agent.activity.shift();
			options.updateOverlay();
		}
		if (event.type === "agent_settled") finishRun(agent, agent.error ? "failed" : "completed", agent.error);
	};

	const attachClient = (agent: ManagedAgent, client: AgentClient): void => {
		agent.client = client;
		client.onEvent((event) => {
			if (agent.client !== client) return;
			handleEvent(agent, event);
			options.refreshTranscript();
		});
		client.onExit((error) => {
			if (agent.client !== client) return;
			agent.client = undefined;
			options.updateOverlay();
			void agent.fork.cleanup().then(
				() => {
					agent.cleanupComplete = true;
					if (isActive(agent)) finishRun(agent, "failed", error.message);
					else {
						if (agent.status !== "closed") {
							agent.status = "closed";
							agent.endedAt ??= Date.now();
							options.updateOverlay();
						}
						options.trimClosed();
					}
				},
				(cleanupError) => {
					const message = `${error.message}; context cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
					if (isActive(agent)) finishRun(agent, "failed", message);
					else {
						agent.status = "closed";
						agent.error = boundedText(sanitizeTerminal(message), 4 * 1024);
						agent.endedAt ??= Date.now();
						options.updateOverlay();
					}
				},
			);
		});
	};

	const ensureClient = async (agent: ManagedAgent): Promise<AgentClient> => {
		if (agent.status === "closed" || agent.cleanupComplete) throw new Error(`Agent ${agent.name} is closed`);
		if (agent.hibernatePromise) {
			try { await agent.hibernatePromise; }
			catch (error) { if (!agent.client) throw error; }
		}
		if (agent.resumePromise) return agent.resumePromise;
		if (agent.client) return agent.client;
		const operation = (async () => {
			const client = options.createClient(agent.clientOptions);
			attachClient(agent, client);
			try {
				await client.start();
				options.assertCurrentSession(agent.generation);
				if (agent.status === "closed") throw new Error(`Agent ${agent.name} is closed`);
				return client;
			} catch (error) {
				if (agent.client === client) agent.client = undefined;
				try { await client.stop(); } catch { /* Preserve the restart error. */ }
				throw error;
			}
		})();
		agent.resumePromise = operation;
		try {
			return await operation;
		} finally {
			if (agent.resumePromise === operation) agent.resumePromise = undefined;
		}
	};

	const closeAgent = async (agent: ManagedAgent, suppressNotification = true): Promise<void> => {
		agent.suppressNotifications ||= suppressNotification;
		if (agent.closePromise) return agent.closePromise;
		if (agent.status === "closed" && !agent.client && agent.cleanupComplete) return;
		options.discardMailboxEvents(agent);
		agent.pendingReports.clear();
		agent.queuedMessages = [];
		agent.status = "closed";
		agent.endedAt ??= Date.now();
		if (!agent.runSettled) {
			agent.runSettled = true;
			agent.resolveCompletion();
		}
		options.updateOverlay();
		const operation = (async () => {
			try {
				try { await agent.hibernatePromise; } catch { /* Retry the stop below. */ }
				try { await agent.resumePromise; } catch { /* Cleanup continues below. */ }
				const client = agent.client;
				await client?.stop();
				if (agent.client === client) agent.client = undefined;
				await agent.fork.cleanup();
				agent.cleanupComplete = true;
			} finally {
				options.updateOverlay();
				if (agent.cleanupComplete) options.trimClosed();
			}
		})();
		agent.closePromise = operation;
		try {
			await operation;
		} finally {
			if (agent.closePromise === operation) agent.closePromise = undefined;
		}
	};

	const interruptAgent = async (agent: ManagedAgent): Promise<void> => {
		if (!isActive(agent)) return;
		agent.suppressNotifications = true;
		agent.runSettled = true;
		agent.status = "interrupted";
		agent.endedAt = Date.now();
		agent.error = undefined;
		agent.activity.push("interrupted");
		if (agent.activity.length > 12) agent.activity.shift();
		agent.resolveCompletion();
		options.updateOverlay();
		const client = agent.client;
		if (client) {
			try { await client.abort(); }
			catch (error) {
				agent.activity.push(`abort failed: ${compact(error instanceof Error ? error.message : String(error), 100)}`);
				if (agent.activity.length > 12) agent.activity.shift();
			}
		}
		agent.error = undefined;
		await hibernateAgent(agent);
	};

	return { attachClient, closeAgent, ensureClient, finishRun, hibernateAgent, interruptAgent };
}
