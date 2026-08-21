import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	getTelegramUpdates,
	matchTelegramAnswerUpdate,
	type SentTelegramQuestion,
	type TelegramCredentials,
	type TelegramQuestion,
	type TelegramUpdate,
} from "./bot-api";

const UPDATE_POLL_INTERVAL_MS = 250;
const MAX_SPOOLED_UPDATES = 10_000;

interface LeaderRecord {
	instanceId: string;
	pid: number;
	processStart?: string;
	updatedAt: number;
}

interface OffsetRecord {
	nextOffset: number;
}

export interface SharedTelegramAnswerOptions {
	runtimeDirectory?: string;
	pollIntervalMs?: number;
	pollRetryBaseMs?: number;
	pollUpdates?: (
		credentials: TelegramCredentials,
		offset: number | undefined,
		signal: AbortSignal,
	) => Promise<TelegramUpdate[]>;
	matchUpdate?: (
		credentials: TelegramCredentials,
		sent: SentTelegramQuestion,
		question: TelegramQuestion,
		update: TelegramUpdate,
		signal: AbortSignal,
	) => Promise<{ consumed: boolean; answer?: string }>;
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function botRuntimeDirectory(credentials: TelegramCredentials): string {
	const digest = createHash("sha256").update(credentials.botToken).digest("hex").slice(0, 24);
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	const base = process.env.XDG_RUNTIME_DIR?.trim() || join(tmpdir(), `pi-telegram-${uid}`);
	return join(base, "pi-telegram", `bot-${digest}`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`Telegram coordination path is not a private directory: ${path}`);
	}
	if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
		throw new Error(`Telegram coordination directory has a different owner: ${path}`);
	}
	await chmod(path, 0o700);
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
	try {
		const value = await readFile(`/proc/${pid}/stat`, "utf8");
		const commandEnd = value.lastIndexOf(")");
		if (commandEnd < 0) return undefined;
		// /proc stat field 22 is process start time. The suffix begins at field 3.
		const startTime = value.slice(commandEnd + 2).trim().split(/\s+/)[19];
		return startTime || undefined;
	} catch {
		return undefined;
	}
}

function retryablePollingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("HTTP 409")
		|| message.includes("timed out")
		|| message.includes("network request failed");
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason ?? new Error("Telegram polling was cancelled.");
	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal.reason ?? new Error("Telegram polling was cancelled."));
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		timer.unref?.();
		signal.addEventListener("abort", abort, { once: true });
	});
}

class SharedUpdateCoordinator {
	private readonly instanceId = randomUUID();
	private readonly root: string;
	private readonly updatesDirectory: string;
	private readonly leaderDirectory: string;
	private readonly leaderRecordPath: string;
	private readonly takeoverDirectory: string;
	private readonly offsetPath: string;
	private readonly pollIntervalMs: number;
	private readonly pollRetryBaseMs: number;
	private readonly pollUpdates: NonNullable<SharedTelegramAnswerOptions["pollUpdates"]>;
	private readonly matchUpdate: NonNullable<SharedTelegramAnswerOptions["matchUpdate"]>;
	private leaderController?: AbortController;
	private leaderPromise?: Promise<void>;
	private leaderError?: Error;

	constructor(
		private readonly credentials: TelegramCredentials,
		options: SharedTelegramAnswerOptions,
	) {
		this.root = options.runtimeDirectory ?? botRuntimeDirectory(credentials);
		this.updatesDirectory = join(this.root, "updates");
		this.leaderDirectory = join(this.root, "leader");
		this.leaderRecordPath = join(this.leaderDirectory, "owner.json");
		this.takeoverDirectory = join(this.root, "takeover");
		this.offsetPath = join(this.root, "offset.json");
		this.pollIntervalMs = options.pollIntervalMs ?? UPDATE_POLL_INTERVAL_MS;
		this.pollRetryBaseMs = options.pollRetryBaseMs ?? 1_000;
		this.pollUpdates = options.pollUpdates ?? getTelegramUpdates;
		this.matchUpdate = options.matchUpdate ?? matchTelegramAnswerUpdate;
	}

	async waitForAnswer(
		sent: SentTelegramQuestion,
		question: TelegramQuestion,
		signal: AbortSignal,
	): Promise<string> {
		await this.prepare();
		const seen = new Set<string>();
		try {
			while (!signal.aborted) {
				await this.ensureLeader();
				if (this.leaderError) throw this.leaderError;
				for (const file of await this.updateFiles()) {
					if (seen.has(file)) continue;
					seen.add(file);
					const update = await readJson<TelegramUpdate>(join(this.updatesDirectory, file));
					if (!update) continue;
					const matched = await this.matchUpdate(this.credentials, sent, question, update, signal);
					if (matched.answer !== undefined) return matched.answer;
				}
				await sleep(this.pollIntervalMs, signal);
			}
			throw signal.reason ?? new Error("Telegram answer polling was cancelled.");
		} finally {
			await this.stopLeading();
		}
	}

	private async prepare(): Promise<void> {
		await ensurePrivateDirectory(this.root);
		await ensurePrivateDirectory(this.updatesDirectory);
	}

	private async ensureLeader(): Promise<void> {
		if (this.leaderPromise) return;
		if (!await this.acquireLeader()) return;
		const controller = new AbortController();
		this.leaderError = undefined;
		this.leaderController = controller;
		this.leaderPromise = this.runLeader(controller.signal)
			.catch((error) => {
				this.leaderError = error instanceof Error ? error : new Error(String(error));
			});
	}

	private async acquireLeader(): Promise<boolean> {
		if (await this.publishLeader()) return true;

		const owner = await readJson<LeaderRecord>(this.leaderRecordPath);
		if (!await this.leaderIsStale(owner)) return false;
		return this.takeOverStaleLeader(owner);
	}

	private async takeOverStaleLeader(staleOwner: LeaderRecord | undefined): Promise<boolean> {
		await mkdir(this.takeoverDirectory, { recursive: true, mode: 0o700 });
		const order = process.hrtime.bigint().toString().padStart(24, "0");
		const claim = join(this.takeoverDirectory, `${order}-${this.instanceId}.json`);
		await writeJsonAtomic(claim, {
			instanceId: this.instanceId,
			pid: process.pid,
			processStart: await processStartIdentity(process.pid),
			updatedAt: Date.now(),
		} satisfies LeaderRecord);
		try {
			// Let concurrent contenders publish their claims. Older live claims win,
			// so a delayed contender can never remove a newly installed leader.
			await new Promise((resolve) => setTimeout(resolve, 50));
			const current = await readJson<LeaderRecord>(this.leaderRecordPath);
			if (current?.instanceId !== staleOwner?.instanceId || !await this.leaderIsStale(current)) return false;

			const claims: string[] = [];
			for (const name of (await readdir(this.takeoverDirectory)).filter((candidate) => candidate.endsWith(".json")).sort()) {
				const path = join(this.takeoverDirectory, name);
				const candidate = await readJson<LeaderRecord>(path);
				if (!candidate || await this.leaderIsStale(candidate)) {
					await unlink(path).catch(() => {});
					continue;
				}
				claims.push(name);
			}
			if (claims[0] !== basename(claim)) return false;

			const latest = await readJson<LeaderRecord>(this.leaderRecordPath);
			if (latest?.instanceId !== staleOwner?.instanceId || !await this.leaderIsStale(latest)) return false;
			const stale = `${this.leaderDirectory}.stale.${process.pid}.${randomUUID()}`;
			try {
				await rename(this.leaderDirectory, stale);
			} catch {
				return false;
			}
			await rm(stale, { recursive: true, force: true });
			return this.publishLeader();
		} finally {
			await unlink(claim).catch(() => {});
		}
	}

	private async leaderIsStale(owner: LeaderRecord | undefined): Promise<boolean> {
		if (owner && typeof owner.instanceId === "string" && Number.isFinite(owner.updatedAt)) {
			if (!processIsAlive(owner.pid)) return true;
			if (!owner.processStart) return false;
			const currentStart = await processStartIdentity(owner.pid);
			return currentStart !== undefined && currentStart !== owner.processStart;
		}
		try {
			const metadata = await stat(this.leaderDirectory);
			return Date.now() - metadata.mtimeMs > 5_000;
		} catch {
			return false;
		}
	}

	private async publishLeader(): Promise<boolean> {
		const candidate = `${this.leaderDirectory}.candidate.${process.pid}.${randomUUID()}`;
		await mkdir(candidate, { mode: 0o700 });
		try {
			await this.writeLeaderRecord(candidate);
			await rename(candidate, this.leaderDirectory);
			return true;
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) throw error;
			return false;
		} finally {
			await rm(candidate, { recursive: true, force: true });
		}
	}

	private async writeLeaderRecord(directory: string): Promise<void> {
		await writeJsonAtomic(join(directory, "owner.json"), {
			instanceId: this.instanceId,
			pid: process.pid,
			processStart: await processStartIdentity(process.pid),
			updatedAt: Date.now(),
		} satisfies LeaderRecord);
	}

	private async ownsLeadership(): Promise<boolean> {
		return (await readJson<LeaderRecord>(this.leaderRecordPath))?.instanceId === this.instanceId;
	}

	private async runLeader(signal: AbortSignal): Promise<void> {
		let offset = (await readJson<OffsetRecord>(this.offsetPath))?.nextOffset;
		if (!Number.isInteger(offset) || (offset as number) < 0) offset = undefined;

		let consecutiveFailures = 0;
		while (!signal.aborted) {
			try {
				if (!await this.ownsLeadership()) return;
				const updates = await this.pollUpdates(this.credentials, offset, signal);
				consecutiveFailures = 0;
				let nextOffset = offset;
				for (const update of updates) {
					if (!Number.isInteger(update.update_id)) continue;
					const updateId = update.update_id as number;
					await writeJsonAtomic(join(this.updatesDirectory, `${String(updateId).padStart(20, "0")}.json`), update);
					nextOffset = Math.max(nextOffset ?? 0, updateId + 1);
				}
				if (nextOffset !== offset && nextOffset !== undefined) {
					await writeJsonAtomic(this.offsetPath, { nextOffset } satisfies OffsetRecord);
					offset = nextOffset;
				}
				await this.pruneUpdates();
			} catch (error) {
				if (signal.aborted) return;
				consecutiveFailures += 1;
				if (!retryablePollingError(error) || consecutiveFailures >= 5) throw error;
				await sleep(Math.min(this.pollRetryBaseMs * consecutiveFailures, 5_000), signal).catch(() => {});
			}
		}
	}

	private async updateFiles(): Promise<string[]> {
		try {
			return (await readdir(this.updatesDirectory))
				.filter((name) => /^\d{20}\.json$/.test(name))
				.sort();
		} catch {
			return [];
		}
	}

	private async pruneUpdates(): Promise<void> {
		const files = await this.updateFiles();
		const obsolete = files.slice(0, Math.max(0, files.length - MAX_SPOOLED_UPDATES));
		await Promise.all(obsolete.map((file) => unlink(join(this.updatesDirectory, file)).catch(() => {})));
	}

	private async stopLeading(): Promise<void> {
		const controller = this.leaderController;
		const promise = this.leaderPromise;
		if (!controller || !promise) return;
		controller.abort();
		await promise.catch(() => {});
		const owner = await readJson<LeaderRecord>(this.leaderRecordPath);
		if (owner?.instanceId === this.instanceId) await rm(this.leaderDirectory, { recursive: true, force: true });
		this.leaderController = undefined;
		this.leaderPromise = undefined;
		this.leaderError = undefined;
	}
}

/**
 * Wait for one Telegram answer while sharing a single getUpdates consumer with
 * every Pi process on this machine that uses the same bot token.
 */
export async function waitForSharedTelegramAnswer(
	credentials: TelegramCredentials,
	sent: SentTelegramQuestion,
	question: TelegramQuestion,
	signal: AbortSignal,
	options: SharedTelegramAnswerOptions = {},
): Promise<string> {
	return new SharedUpdateCoordinator(credentials, options).waitForAnswer(sent, question, signal);
}
