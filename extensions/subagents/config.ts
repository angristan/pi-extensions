import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HARD_MAX_WAIT_MS = 60 * 60_000;

export interface SubagentsRuntimeConfig {
	wait: {
		minimumMs: number;
		defaultMs: number;
		maximumMs: number;
	};
	mailbox: {
		maxMessageBytes: number;
		maxMessagesPerAgent: number;
	};
}

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsRuntimeConfig = {
	wait: {
		minimumMs: 0,
		defaultMs: 5 * 60_000,
		maximumMs: HARD_MAX_WAIT_MS,
	},
	mailbox: {
		maxMessageBytes: 48 * 1024,
		maxMessagesPerAgent: 4,
	},
};

function integer(value: unknown, fallback: number): number {
	return Number.isInteger(value) ? Number(value) : fallback;
}

export function normalizeSubagentsConfig(value: unknown): SubagentsRuntimeConfig {
	const source = value && typeof value === "object" ? value as any : {};
	const minimumMs = integer(source.wait?.minimumMs, DEFAULT_SUBAGENTS_CONFIG.wait.minimumMs);
	const defaultMs = integer(source.wait?.defaultMs, DEFAULT_SUBAGENTS_CONFIG.wait.defaultMs);
	const maximumMs = integer(source.wait?.maximumMs, DEFAULT_SUBAGENTS_CONFIG.wait.maximumMs);
	const validWait = minimumMs >= 0
		&& minimumMs <= defaultMs
		&& defaultMs <= maximumMs
		&& maximumMs <= HARD_MAX_WAIT_MS;

	const maxMessageBytes = integer(source.mailbox?.maxMessageBytes, DEFAULT_SUBAGENTS_CONFIG.mailbox.maxMessageBytes);
	const maxMessagesPerAgent = integer(source.mailbox?.maxMessagesPerAgent, DEFAULT_SUBAGENTS_CONFIG.mailbox.maxMessagesPerAgent);
	const validMailbox = maxMessageBytes >= 8 * 1024
		&& maxMessageBytes <= 1024 * 1024
		&& maxMessagesPerAgent >= 1
		&& maxMessagesPerAgent <= 100;

	return {
		wait: validWait
			? { minimumMs, defaultMs, maximumMs }
			: { ...DEFAULT_SUBAGENTS_CONFIG.wait },
		mailbox: validMailbox
			? { maxMessageBytes, maxMessagesPerAgent }
			: { ...DEFAULT_SUBAGENTS_CONFIG.mailbox },
	};
}

export function subagentsConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "subagents.json");
}

export function loadSubagentsConfig(path = subagentsConfigPath()): SubagentsRuntimeConfig {
	try {
		return normalizeSubagentsConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return normalizeSubagentsConfig(undefined);
	}
}
