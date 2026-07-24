import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAgentSnapshot, type AgentSnapshot } from "./lifecycle.js";
import type { AgentMailbox, AgentMailboxEvent } from "./mailbox.js";

export const MAILBOX_STATE_ENTRY_TYPE = "subagent-mailbox-state";

export type MailboxFinalState = "unread" | "delivered";

export interface PersistedMailboxState {
	version: 1;
	key: string;
	state: MailboxFinalState;
	event?: Omit<AgentMailboxEvent<AgentSnapshot>, "sequence">;
}

function mailboxEventKey(event: Pick<AgentMailboxEvent, "agentId" | "createdAt" | "persistenceKey">): string {
	return event.persistenceKey ?? `${event.agentId}:${event.createdAt}`;
}

export function createMailboxPersistence(
	pi: Pick<ExtensionAPI, "appendEntry">,
	mailbox: AgentMailbox<AgentSnapshot>,
) {
	const persistFinal = (event: AgentMailboxEvent<AgentSnapshot>, state: MailboxFinalState): void => {
		if (event.kind !== "final") return;
		const persisted: PersistedMailboxState = state === "unread"
			? {
				version: 1,
				key: mailboxEventKey(event),
				state,
				event: {
					kind: event.kind,
					agentId: event.agentId,
					agentName: event.agentName,
					content: event.content,
					createdAt: event.createdAt,
					persistenceKey: event.persistenceKey,
					status: event.status,
					final: event.final,
					omittedBefore: event.omittedBefore,
				},
			}
			: { version: 1, key: mailboxEventKey(event), state };
		pi.appendEntry(MAILBOX_STATE_ENTRY_TYPE, persisted);
	};

	const restoreFinals = (ctx: any): void => {
		const latest = new Map<string, PersistedMailboxState>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry?.type !== "custom" || entry.customType !== MAILBOX_STATE_ENTRY_TYPE) continue;
			const data = entry.data as PersistedMailboxState | undefined;
			if (data?.version !== 1 || typeof data.key !== "string" || (data.state !== "unread" && data.state !== "delivered")) continue;
			latest.set(data.key, data);
		}
		for (const data of latest.values()) {
			const event = data.state === "unread" ? data.event : undefined;
			if (!event || event.kind !== "final" || !isAgentSnapshot(event.final) || typeof event.agentId !== "string" || typeof event.agentName !== "string" || typeof event.content !== "string" || typeof event.createdAt !== "number") continue;
			if ((event.persistenceKey !== undefined && typeof event.persistenceKey !== "string") || mailboxEventKey(event) !== data.key) continue;
			mailbox.restore(event);
		}
	};

	return { persistFinal, restoreFinals };
}
