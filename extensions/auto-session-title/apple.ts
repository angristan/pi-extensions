import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const HELPER_PATH = fileURLToPath(new URL("./apple-model.swift", import.meta.url));

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

function runAppleTitleHelper(request: AppleTitleRequest, signal: AbortSignal): Promise<string> {
	if (process.platform !== "darwin") {
		throw new Error("Apple Foundation Models title generation requires macOS 26 or later.");
	}

	return new Promise((resolve, reject) => {
		const child = spawn("/usr/bin/xcrun", ["swift", HELPER_PATH], {
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
