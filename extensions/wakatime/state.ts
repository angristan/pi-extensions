/**
 * Dependency graph:
 * Direct: `./paths.js`, `node:crypto`, `node:fs`, `node:path`.
 * Used by: `extensions/wakatime/index.ts`, `extensions/wakatime/state.test.ts`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWakatimeResourcesDir } from "./paths.js";

const HEARTBEAT_INTERVAL_SECONDS = 60;

interface StoredState {
	lastHeartbeatAt?: number;
}

export function timestamp(): number {
	return Math.floor(Date.now() / 1000);
}

export function shouldSendHeartbeat(
	lastHeartbeatAt: number | undefined,
	now = timestamp(),
	force = false,
): boolean {
	return force || now - (lastHeartbeatAt ?? 0) >= HEARTBEAT_INTERVAL_SECONDS;
}

export class ProjectHeartbeatState {
	private readonly filePath: string;

	constructor(projectFolder: string) {
		const hash = createHash("sha256")
			.update(projectFolder)
			.digest("hex")
			.slice(0, 8);
		this.filePath = join(getWakatimeResourcesDir(), `pi-${hash}.json`);
	}

	read(): StoredState {
		try {
			return JSON.parse(readFileSync(this.filePath, "utf8")) as StoredState;
		} catch {
			return {};
		}
	}

	shouldSend(force = false): boolean {
		return shouldSendHeartbeat(this.read().lastHeartbeatAt, timestamp(), force);
	}

	markSent(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(
				this.filePath,
				`${JSON.stringify({ lastHeartbeatAt: timestamp() }, null, 2)}\n`,
			);
		} catch {
			// Heartbeat state must never break the host session.
		}
	}
}
