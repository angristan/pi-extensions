import { afterEach, expect, test } from "bun:test";
import workingTimer, { formatWorkingMessage, pulseText } from "./index";

const testTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	getFgAnsi: (color: string) => {
		if (color === "text") return "\x1b[38;2;100;100;100m";
		if (color === "muted") return "\x1b[38;2;80;80;80m";
		if (color === "accent") return "\x1b[38;2;200;120;80m";
		return "\x1b[39m";
	},
};
const stripTestStyles = (text: string | undefined) =>
	text?.replace(/\x1b\[38;2;\d+;\d+;\d+m|\x1b\[(?:1|2|22|39)m|<\/?(?:accent|dim)>/g, "") ?? "";

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

afterEach(() => {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
});

test("hides Pi's working spinner and restores the default on shutdown", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	workingTimer({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const indicators: any[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWorkingIndicator: (indicator?: any) => indicators.push(indicator),
			setWorkingMessage() {},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	expect(indicators[0]).toEqual({ frames: [] });

	handlers.get("session_shutdown")?.({}, ctx);
	expect(indicators.at(-1)).toBeUndefined();
});

test("updates phase text and restores Pi's working message when settled", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const intervalTicks: Array<() => void> = [];
	globalThis.setInterval = ((callback: () => void, ms?: number) => {
		expect(ms).toBe(120);
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
	const firstWaitingMessage = messages.at(-1);
	for (let i = 0; i < 6; i++) intervalTicks[0]?.();
	expect(stripTestStyles(messages.at(-1))).toStartWith("Waiting for model (0s");
	expect(messages.at(-1)).not.toBe(firstWaitingMessage);

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

test("pulses the whole phase label into accent and dims the elapsed suffix", () => {
	const first = formatWorkingMessage("thinking", 65_000, "escape", 0, testTheme);
	const next = formatWorkingMessage("thinking", 65_000, "escape", 8, testTheme);

	expect(stripTestStyles(first)).toBe("Thinking (1m 05s • escape to interrupt)");
	expect(first).toContain("<dim>(1m 05s • escape to interrupt)</dim>");
	expect(stripTestStyles(next)).toBe(stripTestStyles(first));
	expect(next).not.toBe(first);
	expect(pulseText("Thinking", 0, testTheme)).toBe("\x1b[38;2;100;100;100mThinking");
	expect(pulseText("Thinking", 6, testTheme)).toBe("\x1b[38;2;150;110;90mThinking");
	expect(pulseText("Thinking", 12, testTheme)).toBe("\x1b[38;2;200;120;80mThinking");
});
