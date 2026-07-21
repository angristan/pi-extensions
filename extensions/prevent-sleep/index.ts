import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

interface RuntimeDependencies {
	platform?: NodeJS.Platform;
	pid?: number;
	spawn?: typeof spawn;
}

/** Keep macOS awake while Pi is processing a complete user-visible run. */
export default function preventSleep(pi: ExtensionAPI, deps: RuntimeDependencies = {}) {
	if ((deps.platform ?? process.platform) !== "darwin") return;

	const spawnProcess = deps.spawn ?? spawn;
	const pid = deps.pid ?? process.pid;
	let inhibitor: ReturnType<typeof spawn> | undefined;

	const stop = () => {
		const child = inhibitor;
		inhibitor = undefined;
		child?.kill("SIGTERM");
	};

	const start = () => {
		if (inhibitor) return;

		const child = spawnProcess(
			"/usr/bin/caffeinate",
			["-i", "-w", String(pid)],
			{ stdio: "ignore" },
		);
		inhibitor = child;

		const clear = () => {
			if (inhibitor === child) inhibitor = undefined;
		};
		child.once("error", clear);
		child.once("exit", clear);
	};

	// agent_settled is the full run boundary: retries, compaction recovery, and
	// queued continuations remain covered by the same idle-sleep assertion.
	pi.on("agent_start", start);
	pi.on("agent_settled", stop);
	pi.on("session_shutdown", stop);
}
