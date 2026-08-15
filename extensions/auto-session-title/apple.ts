import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const HELPER_SOURCE_PATH = fileURLToPath(new URL("./apple-model.swift", import.meta.url));

export const APPLE_TITLE_PROVIDER = "apple-foundation-models";
export const APPLE_TITLE_MODEL = "system";

interface AppleTitleRequest {
	systemPrompt: string;
	prompt: string;
}

export type AppleTitleRunner = (request: AppleTitleRequest, signal: AbortSignal) => Promise<string>;

export function isAppleTitleModel(provider: string, model: string): boolean {
	return provider === APPLE_TITLE_PROVIDER && model === APPLE_TITLE_MODEL;
}

export function appleHelperBinaryPath(source: Uint8Array, agentDir = getAgentDir()): string {
	const digest = createHash("sha256")
		.update(source)
		.update(`\0${process.platform}\0${process.arch}`)
		.digest("hex")
		.slice(0, 16);
	return join(agentDir, "cache", "auto-session-title", `apple-model-${digest}`);
}

let helperBuild: Promise<string> | undefined;

function compileAppleTitleHelper(): Promise<string> {
	if (process.platform !== "darwin") {
		throw new Error("Apple Foundation Models title generation requires macOS 26 or later.");
	}
	const source = readFileSync(HELPER_SOURCE_PATH);
	const binaryPath = appleHelperBinaryPath(source);
	if (existsSync(binaryPath)) return Promise.resolve(binaryPath);
	if (helperBuild) return helperBuild;

	helperBuild = new Promise((resolve, reject) => {
		mkdirSync(join(getAgentDir(), "cache", "auto-session-title"), { recursive: true });
		const temporaryPath = `${binaryPath}.building-${process.pid}`;
		const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const child = spawn("/usr/bin/xcrun", [
			"swiftc",
			"-parse-as-library",
			HELPER_SOURCE_PATH,
			"-o",
			temporaryPath,
		], { stdio: ["ignore", "pipe", "pipe"], signal });
		let output = "";
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve(binaryPath);
		};
		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
				child.kill();
				finish(new Error("Apple Foundation Model helper compiler exceeded its output limit."));
			}
		};

		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code !== 0) {
				finish(new Error(output.trim() || `Apple Foundation Model helper compilation exited with status ${code ?? "unknown"}.`));
				return;
			}
			try {
				renameSync(temporaryPath, binaryPath);
				finish();
			} catch (error) {
				// Another Pi process may have won the same content-addressed build.
				if (existsSync(binaryPath)) finish();
				else finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}).catch((error) => {
		helperBuild = undefined;
		throw error;
	});
	return helperBuild;
}

async function runAppleTitleHelper(request: AppleTitleRequest, signal: AbortSignal): Promise<string> {
	const binaryPath = await compileAppleTitleHelper();
	if (signal.aborted) return "";

	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve(stdout.trim());
		};
		const append = (current: string, chunk: Buffer): string => {
			const next = current + chunk.toString("utf8");
			if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
				child.kill();
				finish(new Error("Apple Foundation Model helper exceeded its output limit."));
			}
			return next;
		};

		child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
		child.stdin.on("error", (error) => {
			if (!signal.aborted) finish(error);
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0 && stdout.trim()) finish();
			else finish(new Error(stderr.trim() || `Apple Foundation Model helper exited with status ${code ?? "unknown"}.`));
		});
		child.stdin.end(JSON.stringify(request));
	});
}

export async function requestAppleTitleCompletion(
	systemPrompt: string,
	prompt: string,
	signal: AbortSignal,
	runner: AppleTitleRunner = runAppleTitleHelper,
): Promise<string> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = AbortSignal.any([signal, timeout]);
	try {
		return await runner({ systemPrompt, prompt }, requestSignal);
	} catch (error) {
		if (signal.aborted) return "";
		if (timeout.aborted) throw new Error("Apple Foundation Model title request timed out.", { cause: error });
		throw error;
	}
}
