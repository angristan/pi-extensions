import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG = join(homedir(), ".pi", "agent", "openai-codex-fast.json");
const FAST_MODELS = /^(?:gpt-5\.4|gpt-5\.5|gpt-5\.6-(?:sol|terra|luna))$/;

function loadEnabled(): boolean {
	try { return JSON.parse(readFileSync(CONFIG, "utf8"))?.enabled === true; } catch { return false; }
}

async function saveEnabled(enabled: boolean) {
	await mkdir(dirname(CONFIG), { recursive: true });
	await writeFile(CONFIG, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

function supportsFastMode(model: any): boolean {
	return model?.provider === "openai-codex" && FAST_MODELS.test(model.id);
}

export default function (pi: ExtensionAPI) {
	let enabled = loadEnabled();

	const updateStatus = (ctx: any) => {
		ctx.ui.setStatus("fast", enabled && supportsFastMode(ctx.model) ? "fast" : undefined);
	};

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect OpenAI Codex Fast mode",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "status") {
				const support = supportsFastMode(ctx.model) ? "supported" : "unsupported by the current model";
				ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"} (${support}).`, "info");
				return;
			}
			if (!["on", "off", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /fast on|off|toggle|status", "warning");
				return;
			}
			enabled = action === "toggle" ? !enabled : action === "on";
			await saveEnabled(enabled);
			updateStatus(ctx);
			ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFastMode(ctx.model)) return;
		return { ...(event.payload as object), service_tier: "priority" };
	});
	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("fast", undefined));
}
