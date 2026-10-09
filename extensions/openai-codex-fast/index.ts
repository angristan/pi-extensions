import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function openaiCodexFastConfigPath(): string {
	return join(getAgentDir(), "openai-codex-fast.json");
}

function loadEnabled(): boolean {
	try { return JSON.parse(readFileSync(openaiCodexFastConfigPath(), "utf8"))?.enabled === true; } catch { return false; }
}

async function saveEnabled(enabled: boolean) {
	const path = openaiCodexFastConfigPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

function canRequestPriority(model: ExtensionContext["model"]): boolean {
	return model?.provider === "openai-codex";
}

function isPriorityRejection(error: string): boolean {
	const unavailableTier = /\b(?:service[_ -]tier|priority(?: service(?: tier)?)?)(?:\s*:\s*['"]?priority['"]?)?\s+(?:is\s+)?(?:unsupported|not supported|unavailable|not available|not allowed|not enabled|disallowed)\b/i;
	const unsupportedTier = /\b(?:unsupported|unavailable|disallowed)\s+['"]?(?:service[_ -]tier|priority)\b/i;
	const invalidTier = /\b(?:invalid|unknown|unrecognized)\s+(?:parameter\s*:\s*)?['"]?service[_ -]tier\b/i;
	return unavailableTier.test(error) || unsupportedTier.test(error) || invalidTier.test(error);
}

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let requestedModel: string | undefined;
	let rejectedModel: string | undefined;

	const updateStatus = (ctx: ExtensionContext) => {
		const unavailable = !canRequestPriority(ctx.model) || rejectedModel === ctx.model?.id;
		ctx.ui.setStatus("fast", enabled ? (unavailable ? "fast unavailable" : "fast") : undefined);
	};

	const describeState = (ctx: ExtensionContext): string => {
		if (!enabled) return "Fast mode is off; priority is not requested.";
		if (!ctx.model) return "Fast mode is on, but unavailable: no model selected.";
		if (!canRequestPriority(ctx.model)) return "Fast mode is on, but unavailable: it only applies to openai-codex.";
		if (rejectedModel === ctx.model.id) return "Fast mode is on, but the last priority request was rejected. The next request will still ask for priority; use /fast off to disable it.";
		return "Fast mode is on; it requests priority for this model. Server acceptance is not confirmed by the badge.";
	};

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect OpenAI Codex priority requests",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "status") {
				ctx.ui.notify(describeState(ctx), "info");
				return;
			}
			if (!["on", "off", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /fast on|off|toggle|status", "warning");
				return;
			}
			enabled = action === "toggle" ? !enabled : action === "on";
			await saveEnabled(enabled);
			requestedModel = undefined;
			rejectedModel = undefined;
			updateStatus(ctx);
			ctx.ui.notify(describeState(ctx), "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !ctx.model || !canRequestPriority(ctx.model)) return;
		requestedModel = ctx.model.id;
		rejectedModel = undefined;
		updateStatus(ctx);
		return { ...(event.payload as object), service_tier: "priority" };
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.provider !== "openai-codex" || message.model !== requestedModel) return;
		requestedModel = undefined;
		if (!enabled || message.stopReason !== "error" || !isPriorityRejection(message.errorMessage ?? "")) return;
		rejectedModel = message.model;
		updateStatus(ctx);
		ctx.ui.notify("The API rejected the priority request. Fast mode remains on; use /fast off to stop requesting priority. No fallback request was sent.", "warning");
	});
	const resetStatus = (_event: unknown, ctx: ExtensionContext) => {
		requestedModel = undefined;
		rejectedModel = undefined;
		updateStatus(ctx);
	};
	pi.on("session_start", resetStatus);
	pi.on("model_select", resetStatus);
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("fast", undefined));
}
