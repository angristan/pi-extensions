import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	SessionManager,
	buildSessionContext,
	type SessionContext,
} from "@earendil-works/pi-coding-agent";

const INHERITED_SUMMARY_TYPE = "subagent-inherited-summary";

export interface ContextFork {
	directory: string;
	sessionFile: string;
	messageCount: number;
	cleanup(): Promise<void>;
}

function toolCallIds(message: any): Array<string | undefined> {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content
		.filter((part: any) => part?.type === "toolCall")
		.map((part: any) => typeof part.id === "string" ? part.id : undefined);
}

export function forkableMessages(context: SessionContext): any[] {
	const messages = [...context.messages];
	const resolvedToolCalls = new Set<string>();
	// Sequential sibling tools may append results after the current assistant
	// message before `agents` executes. Find the newest assistant batch and fork
	// before it whenever any call still lacks a matching result.
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			resolvedToolCalls.add(message.toolCallId);
			continue;
		}
		if (message?.role !== "assistant") continue;
		const ids = toolCallIds(message);
		if (ids.length === 0) return messages;
		return ids.some((id) => !id || !resolvedToolCalls.has(id)) ? messages.slice(0, index) : messages;
	}
	return messages;
}

function appendInheritedMessage(session: SessionManager, message: any): void {
	if (message?.role === "compactionSummary") {
		session.appendCustomMessageEntry(
			INHERITED_SUMMARY_TYPE,
			`Inherited conversation summary:\n${message.summary ?? ""}`,
			false,
		);
		return;
	}
	if (message?.role === "branchSummary") {
		session.appendCustomMessageEntry(
			INHERITED_SUMMARY_TYPE,
			`Inherited branch summary:\n${message.summary ?? ""}`,
			false,
		);
		return;
	}
	session.appendMessage(structuredClone(message));
}

export async function createContextFork(ctx: any): Promise<ContextFork> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
	let cleanupPromise: Promise<void> | undefined;
	try {
		const context = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		);
		const parentSession = ctx.sessionManager.getSessionFile();
		const sessionFile = join(directory, "context.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: ctx.cwd,
			...(parentSession ? { parentSession } : {}),
		})}\n`, { encoding: "utf8", mode: 0o600 });
		const session = SessionManager.open(sessionFile, directory, ctx.cwd);
		if (context.model) session.appendModelChange(context.model.provider, context.model.modelId);
		if (context.thinkingLevel) session.appendThinkingLevelChange(context.thinkingLevel);
		const messages = forkableMessages(context);
		for (const message of messages) appendInheritedMessage(session, message);
		return {
			directory,
			sessionFile,
			messageCount: messages.length,
			cleanup() {
				if (!cleanupPromise) {
					cleanupPromise = rm(directory, { recursive: true, force: true }).catch((error) => {
						cleanupPromise = undefined;
						throw error;
					});
				}
				return cleanupPromise;
			},
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
