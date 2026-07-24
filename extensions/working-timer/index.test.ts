import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workingTimer, { formatWorkingMessage, loadWorkingTimerConfig, normalizeWorkingTimerConfig, workingTimerConfigPath } from "./index";

const testTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};
const stripTestStyles = (text: string | undefined) => text?.replace(/\x1b\[39m|<\/?(?:accent|dim)>/g, "") ?? "";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-working-timer-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	rmSync(agentDirectory, { recursive: true, force: true });
});

test("reads spinner config from the configured Pi agent directory", () => {
	writeFileSync(join(agentDirectory, "working-timer.json"), JSON.stringify({ spinner: "rail-3" }));

	expect(workingTimerConfigPath()).toBe(join(agentDirectory, "working-timer.json"));
	expect(loadWorkingTimerConfig()).toEqual({ spinner: "rail-3" });
});

test("normalizes spinner config with native as the safe default", () => {
	expect(normalizeWorkingTimerConfig(undefined)).toEqual({ spinner: "native" });
	expect(normalizeWorkingTimerConfig({ spinner: "rail-3" })).toEqual({ spinner: "rail-3" });
	expect(normalizeWorkingTimerConfig({ spinner: "rail-3-eased" })).toEqual({ spinner: "rail-3-eased" });
	expect(normalizeWorkingTimerConfig({ spinner: "wat" })).toEqual({ spinner: "native" });
});

test("uses Pi's native accent spinner by default and restores it on shutdown", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
		loadConfig: () => ({ spinner: "native" }),
	});
	const indicators: any[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: testTheme,
			setWorkingIndicator: (indicator?: any) => indicators.push(indicator),
			setWorkingMessage() {},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	expect(indicators[0]).toBeUndefined();

	handlers.get("session_shutdown")?.({}, ctx);
	expect(indicators).toEqual([undefined, undefined]);
});

test("can use the optional eased rail spinner", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any, {
		loadConfig: () => ({ spinner: "rail-3-eased" }),
	});
	const indicators: any[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: testTheme,
			setWorkingIndicator: (indicator?: any) => indicators.push(indicator),
			setWorkingMessage() {},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	expect(indicators[0]).toEqual({
		frames: [
			"<dim>[</dim><accent>•</accent><dim>·</dim><dim>·</dim><dim>]</dim>",
			"<dim>[</dim><accent>•</accent><dim>·</dim><dim>·</dim><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><accent>•</accent><dim>·</dim><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><dim>·</dim><accent>•</accent><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><dim>·</dim><accent>•</accent><dim>]</dim>",
			"<dim>[</dim><dim>·</dim><accent>•</accent><dim>·</dim><dim>]</dim>",
		],
		intervalMs: 260,
	});
});

test("updates phase text and restores Pi's working message when settled", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const intervalTicks: Array<() => void> = [];
	globalThis.setInterval = ((callback: () => void, ms?: number) => {
		expect(ms).toBe(1_000);
		intervalTicks.push(callback);
		return { unref() {} } as any;
	}) as any;
	globalThis.clearInterval = (() => {}) as any;

	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const messages: Array<string | undefined> = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: testTheme,
			setWorkingMessage: (message?: string) => messages.push(message),
		},
	};

	handlers.get("agent_start")?.({}, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Waiting for model (0s");
	for (let i = 0; i < 6; i++) intervalTicks[0]?.();
	expect(stripTestStyles(messages.at(-1))).toStartWith("Waiting for model (0s");

	handlers.get("after_provider_response")?.({ status: 200 }, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Thinking (0s");
	handlers.get("tool_execution_start")?.({}, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Running tools (0s");
	handlers.get("tool_execution_end")?.({}, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Thinking (0s");
	handlers.get("session_before_compact")?.({}, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Compacting (0s");
	handlers.get("session_compact")?.({ willRetry: true }, ctx);
	expect(stripTestStyles(messages.at(-1))).toStartWith("Retrying (0s");
	expect(stripTestStyles(messages.filter(Boolean).join("\n"))).not.toContain("...");

	handlers.get("agent_settled")?.({}, ctx);
	expect(messages.at(-1)).toBeUndefined();
});

test("formats working messages with stable visible text and interrupt hints", () => {
	expect(formatWorkingMessage("thinking", 65_000, "escape", 1)).toBe("Thinking (1m 05s • escape to interrupt)");
	expect(formatWorkingMessage("tools", 3_723_000, undefined, 1)).toBe("Running tools (1h 02m 03s)");
});

test("keeps phase text stable and dims the elapsed suffix", () => {
	const first = formatWorkingMessage("thinking", 65_000, "escape", testTheme);
	const next = formatWorkingMessage("thinking", 65_000, "escape", 8, testTheme);

	expect(stripTestStyles(first)).toBe("Thinking (1m 05s • escape to interrupt)");
	expect(first).toContain("<dim>(1m 05s • escape to interrupt)</dim>");
	expect(next).toBe(first);
});
