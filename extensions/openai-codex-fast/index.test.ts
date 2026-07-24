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

test("reports state and only patches supported OpenAI Codex requests when enabled", async () => {
	writeFileSync(join(agentDirectory, "openai-codex-fast.json"), JSON.stringify({ enabled: true }));
	const commands = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	openaiCodexFast({
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (name: string, handler: any) => handlers.set(name, handler),
	} as any);
	const notices: string[] = [];
	const statuses: any[] = [];
	const supportedCtx = {
		model: { provider: "openai-codex", id: "gpt-5.4" },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value: any) => statuses.push(value),
		},
	};

	await commands.get("fast").handler("status", supportedCtx);
	const enabled = notices.at(-1)?.includes("is on") ?? false;
	expect(openaiCodexFastConfigPath()).toBe(join(agentDirectory, "openai-codex-fast.json"));
	expect(enabled).toBe(true);
	expect(notices.at(-1)).toContain("supported");
	handlers.get("session_start")?.({}, supportedCtx);
	expect(statuses.at(-1)).toBe(enabled ? "fast" : undefined);

	const patched = handlers.get("before_provider_request")?.({ payload: { input: "hello" } }, supportedCtx);
	expect(patched).toEqual(enabled ? { input: "hello", service_tier: "priority" } : undefined);
	const unsupported = handlers.get("before_provider_request")?.(
		{ payload: { input: "hello" } },
		{ ...supportedCtx, model: { provider: "anthropic", id: "claude" } },
	);
	expect(unsupported).toBeUndefined();
});

test("rejects unknown command arguments without writing configuration", async () => {
	let command: any;
	openaiCodexFast({ registerCommand: (_name: string, options: any) => { command = options; }, on() {} } as any);
	const notices: Array<[string, string]> = [];
	await command.handler("turbo", { ui: { notify: (...args: [string, string]) => notices.push(args) } });
	expect(notices).toEqual([["Usage: /fast on|off|toggle|status", "warning"]]);
	expect(existsSync(openaiCodexFastConfigPath())).toBe(false);
});

test("writes toggles only to the configured Pi agent directory", async () => {
	let command: any;
	openaiCodexFast({ registerCommand: (_name: string, options: any) => { command = options; }, on() {} } as any);
	await command.handler("on", { model: undefined, ui: { notify() {}, setStatus() {} } });

	expect(JSON.parse(readFileSync(join(agentDirectory, "openai-codex-fast.json"), "utf8"))).toEqual({ enabled: true });
});
