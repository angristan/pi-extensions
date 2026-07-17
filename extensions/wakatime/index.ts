/**
 * Dependency graph:
 * Direct: `./cli.js`, `./heartbeat.js`, `./state.js`, `./tracker.js`,
 *   `@earendil-works/pi-coding-agent`.
 * Used by: `Pi extension loader`.
 */
import {
	type ExtensionAPI,
	isEditToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { findWakatimeCli } from "./cli.js";
import { sendHeartbeat } from "./heartbeat.js";
import { ProjectHeartbeatState } from "./state.js";
import { ActivityTracker } from "./tracker.js";

export default function (pi: ExtensionAPI) {
	let cliPath: string | undefined;
	let projectFolder = "";
	let heartbeatState: ProjectHeartbeatState | undefined;
	let tracker = new ActivityTracker();
	let flushChain: Promise<void> = Promise.resolve();
	let sentHeartbeats = 0;
	let lastError: string | undefined;

	const flushNow = async (force: boolean): Promise<void> => {
		if (!cliPath || !heartbeatState || !tracker.hasPending()) return;
		if (!heartbeatState.shouldSend(force)) return;

		const activeCliPath = cliPath;
		const heartbeats = await tracker.drain(projectFolder);
		if (heartbeats.length === 0) return;

		const results = await Promise.all(
			heartbeats.map((heartbeat) =>
				sendHeartbeat(activeCliPath, heartbeat, PI_VERSION),
			),
		);
		heartbeatState.markSent();
		sentHeartbeats += results.filter((result) => result.ok).length;
		lastError = results.find((result) => !result.ok)?.error;
	};

	const flush = (force: boolean): Promise<void> => {
		const next = flushChain.then(() => flushNow(force));
		flushChain = next.catch((error) => {
			lastError = error instanceof Error ? error.message : String(error);
		});
		return next;
	};

	pi.registerCommand("wakatime", {
		description: "Show WakaTime tracking status",
		handler: (_args, ctx) => {
			if (!cliPath) {
				ctx.ui.notify(
					"WakaTime inactive: wakatime-cli was not found on PATH.",
					"info",
				);
				return;
			}

			const details = [
				`WakaTime active: ${cliPath}`,
				`${sentHeartbeats} heartbeat${sentHeartbeats === 1 ? "" : "s"} sent this session`,
			];
			if (lastError) details.push(`last error: ${lastError}`);
			ctx.ui.notify(details.join(" · "), lastError ? "warning" : "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		tracker.clear();
		tracker = new ActivityTracker();
		projectFolder = ctx.cwd;
		cliPath = findWakatimeCli();
		heartbeatState = cliPath
			? new ProjectHeartbeatState(projectFolder)
			: undefined;
		flushChain = Promise.resolve();
		sentHeartbeats = 0;
		lastError = undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!cliPath) return;
		if (
			!isToolCallEventType("edit", event) &&
			!isToolCallEventType("write", event)
		)
			return;
		await tracker.beginMutation(event.toolCallId, ctx.cwd, event.input.path);
	});

	pi.on("tool_result", (event, ctx) => {
		if (!cliPath) return;
		if (isReadToolResult(event)) {
			if (!event.isError && typeof event.input.path === "string") {
				tracker.trackRead(ctx.cwd, event.input.path);
			}
			return;
		}

		if (isEditToolResult(event) || isWriteToolResult(event)) {
			if (typeof event.input.path !== "string") return;
			tracker.completeMutation(
				event.toolCallId,
				ctx.cwd,
				event.input.path,
				!event.isError,
			);
		}
	});

	pi.on("turn_end", async () => {
		await flush(false);
	});

	pi.on("agent_settled", async () => {
		await flush(true);
	});

	pi.on("session_shutdown", async () => {
		await flush(true);
		tracker.clear();
	});
}
