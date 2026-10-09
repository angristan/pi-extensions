import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import openaiCodexFast, { openaiCodexFastConfigPath } from "./index";

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-fast-mode-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	rmSync(agentDirectory, { recursive: true, force: true });
});

function harness(enabled = true) {
	if (enabled) writeFileSync(join(agentDirectory, "openai-codex-fast.json"), JSON.stringify({ enabled }));
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const notices: Array<[string, string]> = [];
	const statuses = new Map<string, string | undefined>();
	openaiCodexFast({
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (name: string, handler: any) => handlers.set(name, handler),
	} as any);
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-6.1-sol" } as { provider: string; id: string } | undefined,
		ui: {
			notify: (message: string, level: string) => notices.push([message, level]),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
		},
	};
	const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	return { ctx, emit, notices, statuses, command: (args: string) => commands.get("fast").handler(args, ctx) };
}

for (const id of ["gpt-5.4", "gpt-6.1-sol", "future-model"]) {
	test(`requests priority for openai-codex/${id} without changing the payload`, () => {
		const h = harness();
		h.ctx.model!.id = id;
		h.emit("session_start");
		expect(h.statuses.get("fast")).toBe("fast");
		const payload = { model: id, input: [{ role: "user", content: "hello" }], reasoning: { effort: "high" } };
		expect(h.emit("before_provider_request", { payload })).toEqual({ ...payload, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
	});
}

test("keeps other providers unchanged and explains the unavailable badge", async () => {
	const h = harness();
	h.ctx.model = { provider: "anthropic", id: "claude" };
	h.emit("model_select");
	expect(h.statuses.get("fast")).toBe("fast unavailable");
	expect(h.emit("before_provider_request", { payload: { input: "hello" } })).toBeUndefined();
	await h.command("status");
	expect(h.notices.at(-1)?.[0]).toContain("only applies to openai-codex");
	h.ctx.model = { provider: "openai-codex", id: "future-model" };
	h.emit("model_select");
	expect(h.statuses.get("fast")).toBe("fast");
});

test("reports a missing model without claiming priority is active", async () => {
	const h = harness();
	h.ctx.model = undefined;
	h.emit("session_start");
	expect(h.statuses.get("fast")).toBe("fast unavailable");
	await h.command("status");
	expect(h.notices.at(-1)?.[0]).toContain("no model selected");
});

test("defaults off, persists toggles, and describes priority as a request", async () => {
	const h = harness(false);
	h.emit("session_start");
	expect(h.statuses.get("fast")).toBeUndefined();
	expect(h.emit("before_provider_request", { payload: {} })).toBeUndefined();
	await h.command("on");
	expect(openaiCodexFastConfigPath()).toBe(join(agentDirectory, "openai-codex-fast.json"));
	expect(JSON.parse(readFileSync(openaiCodexFastConfigPath(), "utf8"))).toEqual({ enabled: true });
	expect(h.statuses.get("fast")).toBe("fast");
	await h.command("status");
	expect(h.notices.at(-1)?.[0]).toContain("requests priority");
	expect(h.notices.at(-1)?.[0]).toContain("not confirmed");
	await h.command("toggle");
	expect(JSON.parse(readFileSync(openaiCodexFastConfigPath(), "utf8"))).toEqual({ enabled: false });
	expect(h.statuses.get("fast")).toBeUndefined();
	expect(h.emit("before_provider_request", { payload: {} })).toBeUndefined();
});

for (const errorMessage of [
	"Invalid service_tier: priority is not supported for this model",
	"Unknown parameter: 'service_tier'",
	"Priority service tier is not available for this account",
]) {
	test(`reports explicit rejection without changing or retrying the failed request: ${errorMessage}`, async () => {
		const h = harness();
		h.emit("before_provider_request", { payload: {} });
		const message = { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "error", errorMessage };
		expect(h.emit("message_end", { message })).toBeUndefined();
		expect(h.statuses.get("fast")).toBe("fast unavailable");
		expect(h.notices.at(-1)?.[0]).toContain("rejected");
		expect(message.errorMessage).toBe(errorMessage);
		await h.command("status");
		expect(h.notices.at(-1)?.[0]).toContain("last priority request was rejected");
		expect(h.emit("before_provider_request", { payload: {} })).toEqual({ service_tier: "priority" });
		expect(h.statuses.get("fast")).toBe("fast");
	});
}

for (const errorMessage of [
	"429 too many requests",
	"Priority service request timed out",
	"Invalid tool schema",
	"Invalid tool schema; service_tier: priority",
	"Unsupported image format in priority request",
]) {
	test(`does not label ordinary errors as unsupported priority: ${errorMessage}`, () => {
		const h = harness();
		h.emit("before_provider_request", { payload: {} });
		h.emit("message_end", { message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "error", errorMessage } });
		expect(h.statuses.get("fast")).toBe("fast");
		expect(h.notices).toEqual([]);
	});
}

test("ignores errors from another model and clears rejection state on model switch", () => {
	const h = harness();
	h.emit("before_provider_request", { payload: {} });
	const message = { role: "assistant", provider: "openai-codex", model: "other-model", stopReason: "error", errorMessage: "Unsupported service_tier" };
	h.emit("message_end", { message });
	expect(h.statuses.get("fast")).toBe("fast");
	h.emit("before_provider_request", { payload: {} });
	h.emit("message_end", { message: { ...message, model: "gpt-6.1-sol" } });
	expect(h.statuses.get("fast")).toBe("fast unavailable");
	h.ctx.model!.id = "future-model";
	h.emit("model_select");
	expect(h.statuses.get("fast")).toBe("fast");
	h.emit("session_shutdown");
	expect(h.statuses.get("fast")).toBeUndefined();
});

test("rejects unknown command arguments without writing configuration", async () => {
	const h = harness(false);
	await h.command("turbo");
	expect(h.notices).toEqual([["Usage: /fast on|off|toggle|status", "warning"]]);
	expect(existsSync(openaiCodexFastConfigPath())).toBe(false);
});
