/**
 * working-timer — adds elapsed time to Pi's built-in "Working..." row.
 *
 * The first agent_start anchors a user-visible run. The timer remains anchored
 * across retries, automatic compaction, and queued continuations, then resets
 * only after agent_settled. Pi's retry and compaction loaders keep their native
 * messages; the elapsed time resumes when the normal working row returns.
 */
import {
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const UPDATE_INTERVAL_MS = 1_000;
const INDICATOR_INTERVAL_MS = 250;
const INDICATOR_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

export default function workingTimer(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const installIndicator = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({
			frames: INDICATOR_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: INDICATOR_INTERVAL_MS,
		});
	};

	const stop = (ctx?: ExtensionContext) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		startedAt = undefined;
		if (ctx?.mode === "tui") ctx.ui.setWorkingMessage();
	};

	pi.on("session_start", (_event, ctx) => installIndicator(ctx));

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Preserve the first start across retries, compaction, and automatic
		// continuations so this measures the complete user-visible run.
		startedAt ??= Date.now();
		if (timer) return;

		const interruptKey = keyText("app.interrupt");
		const interruptHint = interruptKey ? ` • ${interruptKey} to interrupt` : "";
		const update = () => {
			if (startedAt === undefined) return;
			const elapsed = formatElapsed(Date.now() - startedAt);
			ctx.ui.setWorkingMessage(`Working (${elapsed}${interruptHint})`);
		};

		update();
		timer = setInterval(update, UPDATE_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => stop(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		stop(ctx);
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator();
	});
}
