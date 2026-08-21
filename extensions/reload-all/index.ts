import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const COMMAND = "reload-all";
const INTERNAL_COMMAND_PREFIX = "reload-all-apply";
const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const QUEUE_RETRY_AFTER_MS = 5_000;
const MAX_STATE_FILE_BYTES = 64 * 1024;

interface ReloadGeneration {
	version: 1;
	id: string;
	createdAt: number;
	issuer: string;
}

interface ReloadTarget {
	version: 1;
	key: string;
	pid: number;
	processStart?: string;
	bootId?: string;
	runtimeNonce: string;
	updatedAt: number;
	appliedGeneration?: string;
	requestedGeneration?: string;
	requestRuntimeNonce?: string;
}

interface ProcessIdentity {
	key: string;
	pid: number;
	processStart?: string;
	bootId?: string;
}

interface RuntimeDependencies {
	runtimeDirectory?: string;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	queueRetryAfterMs?: number;
	now?: () => number;
	newGenerationId?: () => string;
	newRuntimeNonce?: () => string;
	processIdentity?: () => Promise<ProcessIdentity>;
	isTargetProcessAlive?: (target: ReloadTarget) => Promise<boolean>;
	setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
	clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
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
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_STATE_FILE_BYTES) return undefined;
		if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return undefined;
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`Reload coordination path is not a private directory: ${path}`);
	}
	if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
		throw new Error(`Reload coordination directory has a different owner: ${path}`);
	}
	await chmod(path, 0o700);
}

async function processStartIdentity(pid: number): Promise<string | undefined> {
	try {
		const value = await readFile(`/proc/${pid}/stat`, "utf8");
		const commandEnd = value.lastIndexOf(")");
		if (commandEnd < 0) return undefined;
		return value.slice(commandEnd + 2).trim().split(/\s+/)[19] || undefined;
	} catch {
		return undefined;
	}
}

async function linuxBootId(): Promise<string | undefined> {
	try {
		return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || undefined;
	} catch {
		return undefined;
	}
}

async function currentProcessIdentity(): Promise<ProcessIdentity> {
	const processStart = await processStartIdentity(process.pid);
	const bootId = await linuxBootId();
	const key = createHash("sha256")
		.update(`${bootId ?? "unknown-boot"}:${process.pid}:${processStart ?? "unknown-start"}`)
		.digest("hex")
		.slice(0, 24);
	return { key, pid: process.pid, processStart, bootId };
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

async function targetProcessIsAlive(target: ReloadTarget): Promise<boolean> {
	if (!processIsAlive(target.pid)) return false;
	if (target.bootId) {
		const currentBoot = await linuxBootId();
		if (currentBoot && currentBoot !== target.bootId) return false;
	}
	if (!target.processStart) return true;
	const currentStart = await processStartIdentity(target.pid);
	return currentStart === undefined || currentStart === target.processStart;
}

function defaultRuntimeDirectory(): string {
	const runtimeBase = process.env.XDG_RUNTIME_DIR?.trim();
	if (runtimeBase) return join(runtimeBase, "pi-reload-all");
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `pi-reload-all-${uid}`);
}

function validGeneration(value: ReloadGeneration | undefined): value is ReloadGeneration {
	return value?.version === 1 && typeof value.id === "string" && Boolean(value.id);
}

function validTarget(value: ReloadTarget | undefined): value is ReloadTarget {
	return value?.version === 1
		&& typeof value.key === "string"
		&& Number.isInteger(value.pid)
		&& typeof value.runtimeNonce === "string"
		&& Number.isFinite(value.updatedAt);
}

export function createReloadAllExtension(dependencies: RuntimeDependencies = {}) {
	return function reloadAll(pi: ExtensionAPI) {
		// Child agents share the parent package and runtime directory. They must
		// never register as independent reload targets or interrupt their RPC work.
		if (process.env[CHILD_ENV] === "1") return;

		const root = dependencies.runtimeDirectory ?? defaultRuntimeDirectory();
		const targetsDirectory = join(root, "targets");
		const generationPath = join(root, "generation.json");
		const pollIntervalMs = dependencies.pollIntervalMs ?? POLL_INTERVAL_MS;
		const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
		const queueRetryAfterMs = dependencies.queueRetryAfterMs ?? QUEUE_RETRY_AFTER_MS;
		const now = dependencies.now ?? Date.now;
		const newGenerationId = dependencies.newGenerationId ?? randomUUID;
		const runtimeNonce = (dependencies.newRuntimeNonce ?? randomUUID)();
		const internalCommand = `${INTERNAL_COMMAND_PREFIX}-${runtimeNonce}`;
		const getProcessIdentity = dependencies.processIdentity ?? currentProcessIdentity;
		const isTargetProcessAlive = dependencies.isTargetProcessAlive ?? targetProcessIsAlive;
		const startInterval = dependencies.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
		const stopInterval = dependencies.clearInterval ?? clearInterval;

		let identity: ProcessIdentity | undefined;
		let targetPath: string | undefined;
		let target: ReloadTarget | undefined;
		let activeCtx: any;
		let timer: ReturnType<typeof setInterval> | undefined;
		let active = false;
		let commandRegistered = false;
		let checking = false;
		let reloadInProgress = false;
		let pendingGeneration: string | undefined;
		let queuedGeneration: string | undefined;
		let queuedAt = 0;
		let lastHeartbeatAt = 0;
		let targetMutation = Promise.resolve();

		const mutateTarget = async (mutation: (current: ReloadTarget) => ReloadTarget): Promise<ReloadTarget> => {
			if (!targetPath || !target) throw new Error("Reload target is not initialized.");
			let result = target;
			targetMutation = targetMutation.then(async () => {
				const stored = await readJson<ReloadTarget>(targetPath!);
				const current = validTarget(stored) && stored.key === target!.key ? stored : target!;
				result = mutation(current);
				await writeJsonAtomic(targetPath!, result);
				target = result;
			});
			await targetMutation;
			return result;
		};

		const liveTargets = async (): Promise<ReloadTarget[]> => {
			const live: ReloadTarget[] = [];
			let files: string[] = [];
			try {
				files = (await readdir(targetsDirectory)).filter((name) => name.endsWith(".json"));
			} catch {
				return live;
			}
			for (const file of files) {
				const path = join(targetsDirectory, file);
				const candidate = await readJson<ReloadTarget>(path);
				const fresh = validTarget(candidate)
					&& basename(file, ".json") === candidate.key
					&& await isTargetProcessAlive(candidate);
				if (!fresh) {
					await unlink(path).catch(() => {});
					continue;
				}
				live.push(candidate);
			}
			return live;
		};

		const applyGeneration = async (generationId: string, ctx: any): Promise<void> => {
			if (!active || reloadInProgress || ctx.mode !== "tui") return;
			await ctx.waitForIdle();
			if (!active || reloadInProgress) return;
			const generation = await readJson<ReloadGeneration>(generationPath);
			if (!validGeneration(generation) || generation.id !== generationId) return;
			if (target?.appliedGeneration === generationId) return;

			await mutateTarget((current) => ({
				...current,
				updatedAt: now(),
				requestedGeneration: generationId,
				requestRuntimeNonce: runtimeNonce,
			}));
			reloadInProgress = true;
			try {
				await ctx.reload();
			} catch (error) {
				reloadInProgress = false;
				await mutateTarget((current) => {
					if (current.requestRuntimeNonce !== runtimeNonce) return current;
					const { requestedGeneration: _requested, requestRuntimeNonce: _requester, ...rest } = current;
					return { ...rest, updatedAt: now() };
				});
				throw error;
			}

			// Interactive Pi may refuse a reload during manual compaction while still
			// resolving ctx.reload(). A new extension runtime proves success by
			// completing this request with its own nonce during session_start.
			const afterReload = targetPath ? await readJson<ReloadTarget>(targetPath) : undefined;
			if (validTarget(afterReload)
				&& afterReload.appliedGeneration === generationId
				&& afterReload.runtimeNonce !== runtimeNonce) return;
			reloadInProgress = false;
			await mutateTarget((current) => {
				if (current.requestRuntimeNonce !== runtimeNonce) return current;
				const { requestedGeneration: _requested, requestRuntimeNonce: _requester, ...rest } = current;
				return { ...rest, updatedAt: now() };
			});
		};

		const queueApply = (generationId: string) => {
			if (!activeCtx || reloadInProgress) return;
			if (queuedGeneration === generationId && now() - queuedAt < queueRetryAfterMs) return;
			queuedGeneration = generationId;
			queuedAt = now();
			try {
				pi.sendUserMessage(`/${internalCommand} ${generationId}`, {
					expandPromptTemplates: true,
				});
			} catch {
				queuedGeneration = undefined;
			}
		};

		const checkGeneration = async () => {
			if (!active || checking || reloadInProgress || !activeCtx) return;
			checking = true;
			try {
				if (now() - lastHeartbeatAt >= heartbeatIntervalMs) {
					await mutateTarget((current) => ({ ...current, updatedAt: now() }));
					lastHeartbeatAt = now();
				}
				const generation = await readJson<ReloadGeneration>(generationPath);
				if (!validGeneration(generation) || target?.appliedGeneration === generation.id) return;
				pendingGeneration = generation.id;
				queueApply(generation.id);
			} finally {
				checking = false;
			}
		};

		const registerCommand = () => {
			if (commandRegistered) return;
			commandRegistered = true;
			pi.registerCommand(internalCommand, {
				description: "Apply a validated machine-local reload generation",
				handler: async (args, ctx) => {
					queuedGeneration = undefined;
					const generationId = args.trim();
					if (!generationId || /\s/.test(generationId) || pendingGeneration !== generationId) return;
					await applyGeneration(generationId, ctx);
				},
			});
			pi.registerCommand(COMMAND, {
				description: "Reload every top-level Pi TUI on this machine after it becomes idle",
				handler: async (args, ctx) => {
					const fields = args.trim().split(/\s+/).filter(Boolean);
					if (fields.length > 0) {
						ctx.ui.notify(`Usage: /${COMMAND}`, "warning");
						return;
					}
					const targets = await liveTargets();
					const confirmed = await ctx.ui.confirm(
						"Reload all Pi sessions?",
						`Reload ${targets.length} top-level TUI session${targets.length === 1 ? "" : "s"}. Busy sessions wait until they become idle.`,
					);
					if (!confirmed) return;

					const generation: ReloadGeneration = {
						version: 1,
						id: newGenerationId(),
						createdAt: now(),
						issuer: identity!.key,
					};
					await writeJsonAtomic(generationPath, generation);
					pendingGeneration = generation.id;
					ctx.ui.notify(`Reload broadcast sent to ${targets.length} top-level session${targets.length === 1 ? "" : "s"}.`, "info");
					await applyGeneration(generation.id, ctx);
				},
			});
		};

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			await ensurePrivateDirectory(root);
			await ensurePrivateDirectory(targetsDirectory);
			identity = await getProcessIdentity();
			targetPath = join(targetsDirectory, `${identity.key}.json`);
			const existing = await readJson<ReloadTarget>(targetPath);
			const generation = await readJson<ReloadGeneration>(generationPath);
			if (validTarget(existing) && existing.key === identity.key) {
				const completedGeneration = existing.requestRuntimeNonce
					&& existing.requestRuntimeNonce !== runtimeNonce
					? existing.requestedGeneration
					: undefined;
				const {
					requestedGeneration: _requested,
					requestRuntimeNonce: _requester,
					...rest
				} = existing;
				target = {
					...rest,
					bootId: identity.bootId,
					runtimeNonce,
					updatedAt: now(),
					...(completedGeneration ? { appliedGeneration: completedGeneration } : {}),
					...(!completedGeneration && existing.requestedGeneration
						? {
							requestedGeneration: existing.requestedGeneration,
							requestRuntimeNonce: existing.requestRuntimeNonce,
						}
						: {}),
				};
			} else {
				target = {
					version: 1,
					key: identity.key,
					pid: identity.pid,
					processStart: identity.processStart,
					bootId: identity.bootId,
					runtimeNonce,
					updatedAt: now(),
					...(validGeneration(generation) ? { appliedGeneration: generation.id } : {}),
				};
			}
			await writeJsonAtomic(targetPath, target);
			activeCtx = ctx;
			active = true;
			lastHeartbeatAt = now();
			registerCommand();
			timer = startInterval(() => { void checkGeneration(); }, pollIntervalMs);
			timer.unref?.();
		});

		pi.on("session_shutdown", async (event) => {
			active = false;
			activeCtx = undefined;
			pendingGeneration = undefined;
			queuedGeneration = undefined;
			if (timer) stopInterval(timer);
			timer = undefined;
			await targetMutation;
			if (event.reason === "quit" && targetPath) await unlink(targetPath).catch(() => {});
		});
	};
}

export default createReloadAllExtension();
