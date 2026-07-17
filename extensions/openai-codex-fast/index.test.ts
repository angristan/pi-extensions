import { expect, test } from "bun:test";
import openaiCodexFast from "./index";

test("reports state and only patches supported OpenAI Codex requests when enabled", async () => {
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
});
