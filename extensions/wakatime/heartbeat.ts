/**
 * Dependency graph:
 * Direct: `node:child_process`, `node:os`.
 * Used by: `extensions/wakatime/heartbeat.test.ts`, `extensions/wakatime/index.ts`,
 *   `extensions/wakatime/tracker.ts`.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";

export const EXTENSION_VERSION = "0.1.0";

export interface Heartbeat {
	entity: string;
	projectFolder: string;
	lineChanges?: number;
	isWrite?: boolean;
}

export interface HeartbeatResult {
	ok: boolean;
	error?: string;
}

export function buildHeartbeatArgs(
	heartbeat: Heartbeat,
	piVersion: string,
): string[] {
	const args = [
		"--entity",
		heartbeat.entity,
		"--entity-type",
		"file",
		"--category",
		"ai coding",
		"--plugin",
		`pi/${piVersion} pi-wakatime/${EXTENSION_VERSION}`,
		"--sync-ai-disabled",
		"--timeout",
		"10",
		"--project-folder",
		heartbeat.projectFolder,
	];

	if (heartbeat.lineChanges !== undefined && heartbeat.lineChanges !== 0) {
		args.push("--ai-line-changes", heartbeat.lineChanges.toString());
	}
	if (heartbeat.isWrite) args.push("--write");
	return args;
}

export function sendHeartbeat(
	cliPath: string,
	heartbeat: Heartbeat,
	piVersion: string,
): Promise<HeartbeatResult> {
	return new Promise((resolve) => {
		const env = { ...process.env };
		if (process.platform !== "win32" && !env.HOME && !env.WAKATIME_HOME) {
			env.WAKATIME_HOME = homedir();
		}

		execFile(
			cliPath,
			buildHeartbeatArgs(heartbeat, piVersion),
			{ encoding: "utf8", env, timeout: 15_000, windowsHide: true },
			(error, _stdout, stderr) => {
				if (!error) {
					resolve({ ok: true });
					return;
				}
				const detail = stderr?.trim() || error.message;
				resolve({ ok: false, error: detail.slice(0, 500) });
			},
		);
	});
}
