import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForSharedTelegramAnswer } from "./coordinator";
import type { TelegramCredentials, TelegramUpdate } from "./bot-api";

const temporaryDirectories: string[] = [];
const credentials: TelegramCredentials = {
	botToken: "123456:test-token",
	chatId: "987654321",
};

function temporaryRuntime(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-telegram-coordinator-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reply(updateId: number, messageId: number, text: string): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			text,
			chat: { id: 987654321 },
			reply_to_message: { message_id: messageId },
		},
	};
}

describe("shared Telegram update coordination", () => {
	test("routes answers to two waiters through one getUpdates consumer", async () => {
		const runtimeDirectory = temporaryRuntime();
		let delivered = false;
		let activePolls = 0;
		let maximumActivePolls = 0;
		let calls = 0;
		const pollUpdates = async (_credentials: TelegramCredentials, _offset: number | undefined, signal: AbortSignal) => {
			calls += 1;
			activePolls += 1;
			maximumActivePolls = Math.max(maximumActivePolls, activePolls);
			try {
				if (!delivered) {
					delivered = true;
					return [reply(100, 42, "answer for A"), reply(101, 43, "answer for B")];
				}
				return await new Promise<TelegramUpdate[]>((resolve) => {
					const abort = () => resolve([]);
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
			} finally {
				activePolls -= 1;
			}
		};
		const options = { runtimeDirectory, pollIntervalMs: 5, pollUpdates };
		const signal = new AbortController().signal;

		const [first, second] = await Promise.all([
			waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 42 }, {
				options: [],
				allowOther: true,
			}, signal, options),
			waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 43 }, {
				options: [],
				allowOther: true,
			}, signal, options),
		]);

		expect(first).toBe("answer for A");
		expect(second).toBe("answer for B");
		expect(calls).toBeGreaterThan(0);
		expect(maximumActivePolls).toBe(1);
	});

	test("retains spooled updates after one waiter consumes its answer", async () => {
		const runtimeDirectory = temporaryRuntime();
		let delivered = false;
		const pollUpdates = async (_credentials: TelegramCredentials, _offset: number | undefined, signal: AbortSignal) => {
			if (!delivered) {
				delivered = true;
				return [reply(200, 51, "first"), reply(201, 52, "second")];
			}
			return await new Promise<TelegramUpdate[]>((resolve) => {
				const abort = () => resolve([]);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		};
		const options = { runtimeDirectory, pollIntervalMs: 5, pollUpdates };
		const signal = new AbortController().signal;

		const first = await waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 51 }, {
			options: [],
			allowOther: true,
		}, signal, options);
		const second = await waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 52 }, {
			options: [],
			allowOther: true,
		}, signal, options);

		expect(first).toBe("first");
		expect(second).toBe("second");
	});

	test("elects one replacement when concurrent waiters find a dead leader", async () => {
		const runtimeDirectory = temporaryRuntime();
		mkdirSync(join(runtimeDirectory, "leader"), { recursive: true, mode: 0o700 });
		writeFileSync(join(runtimeDirectory, "leader", "owner.json"), JSON.stringify({
			instanceId: "dead-owner",
			pid: 2_147_483_647,
			updatedAt: Date.now(),
		}), { mode: 0o600 });
		let delivered = false;
		let activePolls = 0;
		let maximumActivePolls = 0;
		const pollUpdates = async (_credentials: TelegramCredentials, _offset: number | undefined, signal: AbortSignal) => {
			activePolls += 1;
			maximumActivePolls = Math.max(maximumActivePolls, activePolls);
			try {
				if (!delivered) {
					delivered = true;
					return [reply(250, 71, "first"), reply(251, 72, "second")];
				}
				return await new Promise<TelegramUpdate[]>((resolve) => {
					const abort = () => resolve([]);
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
			} finally {
				activePolls -= 1;
			}
		};
		const options = { runtimeDirectory, pollIntervalMs: 5, pollUpdates };
		const signal = new AbortController().signal;

		const answers = await Promise.all([
			waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 71 }, { options: [], allowOther: true }, signal, options),
			waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 72 }, { options: [], allowOther: true }, signal, options),
		]);

		expect(answers).toEqual(["first", "second"]);
		expect(maximumActivePolls).toBe(1);
	});

	test("reports permanent polling failures instead of hanging", async () => {
		const runtimeDirectory = temporaryRuntime();
		const result = waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 81 }, {
			options: [],
			allowOther: true,
		}, new AbortController().signal, {
			runtimeDirectory,
			pollIntervalMs: 5,
			pollRetryBaseMs: 1,
			pollUpdates: async () => { throw new Error("Telegram API request failed (HTTP 401): Unauthorized"); },
		});

		await expect(result).rejects.toThrow("HTTP 401");
		expect(existsSync(join(runtimeDirectory, "leader"))).toBe(false);
	});

	test("continues from the saved Telegram update offset after leadership changes", async () => {
		const runtimeDirectory = temporaryRuntime();
		const offsets: Array<number | undefined> = [];
		const pollUpdates = async (_credentials: TelegramCredentials, offset: number | undefined, signal: AbortSignal) => {
			offsets.push(offset);
			if (offset === undefined) return [reply(300, 61, "first")];
			if (offset === 301) {
				const aborted = await new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => resolve(false), 20);
					const abort = () => { clearTimeout(timer); resolve(true); };
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
				return aborted ? [] : [reply(301, 62, "second")];
			}
			return await new Promise<TelegramUpdate[]>((resolve) => {
				const abort = () => resolve([]);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		};
		const options = { runtimeDirectory, pollIntervalMs: 5, pollUpdates };
		const signal = new AbortController().signal;

		expect(await waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 61 }, {
			options: [],
			allowOther: true,
		}, signal, options)).toBe("first");
		expect(await waitForSharedTelegramAnswer(credentials, { chatId: "987654321", messageId: 62 }, {
			options: [],
			allowOther: true,
		}, signal, options)).toBe("second");

		expect(offsets.slice(0, 2)).toEqual([undefined, 301]);
	});
});
