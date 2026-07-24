import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SUBAGENTS_CONFIG, loadSubagentsConfig, normalizeSubagentsConfig } from "./config";

test("accepts ordered wait limits and mailbox bounds", () => {
	expect(normalizeSubagentsConfig({
		wait: { minimumMs: 1_000, defaultMs: 60_000, maximumMs: 600_000 },
		mailbox: { maxMessageBytes: 96 * 1024, maxMessagesPerAgent: 8 },
	})).toEqual({
		wait: { minimumMs: 1_000, defaultMs: 60_000, maximumMs: 600_000 },
		mailbox: { maxMessageBytes: 96 * 1024, maxMessagesPerAgent: 8 },
	});
});

test("loads timeout and mailbox settings from JSON", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagents-config-"));
	const path = join(directory, "subagents.json");
	try {
		writeFileSync(path, JSON.stringify({
			wait: { minimumMs: 500, defaultMs: 5_000, maximumMs: 50_000 },
			mailbox: { maxMessageBytes: 64 * 1024, maxMessagesPerAgent: 3 },
		}));
		expect(loadSubagentsConfig(path)).toEqual({
			wait: { minimumMs: 500, defaultMs: 5_000, maximumMs: 50_000 },
			mailbox: { maxMessageBytes: 64 * 1024, maxMessagesPerAgent: 3 },
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("falls back independently for invalid wait and mailbox settings", () => {
	const validMailbox = { maxMessageBytes: 64 * 1024, maxMessagesPerAgent: 3 };
	const invalidWait = normalizeSubagentsConfig({
		wait: { minimumMs: 100, defaultMs: 50, maximumMs: 10 },
		mailbox: validMailbox,
	});
	expect(invalidWait.wait).toEqual(DEFAULT_SUBAGENTS_CONFIG.wait);
	expect(invalidWait.mailbox).toEqual(validMailbox);

	const validWait = { minimumMs: 500, defaultMs: 5_000, maximumMs: 50_000 };
	const invalidMailbox = normalizeSubagentsConfig({
		wait: validWait,
		mailbox: { maxMessageBytes: 1, maxMessagesPerAgent: 0 },
	});
	expect(invalidMailbox.wait).toEqual(validWait);
	expect(invalidMailbox.mailbox).toEqual(DEFAULT_SUBAGENTS_CONFIG.mailbox);
});
