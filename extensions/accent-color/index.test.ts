import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import accentColor, { accentBorder, accentColorConfigPath, lockAccentBorder } from "./index";

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
let agentDirectory: string;

beforeEach(() => {
	agentDirectory = mkdtempSync(join(tmpdir(), "pi-accent-color-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
});

afterEach(() => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	rmSync(agentDirectory, { recursive: true, force: true });
});

test("reads accent config from the configured Pi agent directory", () => {
	writeFileSync(join(agentDirectory, "accent-color.json"), JSON.stringify({ color: "#123ABC" }));

	expect(accentColorConfigPath()).toBe(join(agentDirectory, "accent-color.json"));
	expect(accentBorder("border")).toBe("\x1b[38;2;18;58;188mborder\x1b[39m");
});

test("locks the editor border against later Pi updates", () => {
	const original = (text: string) => `old:${text}`;
	const editor: any = { borderColor: original };

	lockAccentBorder(editor);
	const locked = editor.borderColor;
	editor.borderColor = (text: string) => `new:${text}`;

	expect(editor.borderColor).toBe(locked);
	expect(locked("border")).toContain("\x1b[38;2;255;130;5m");
	expect(locked("border")).toEndWith("border\x1b[39m");
	expect(lockAccentBorder(editor)).toBe(editor);
});

test("wraps and restores the previous editor factory only while it owns the editor", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const previous = () => ({ borderColor: (text: string) => text });
	let current: any = previous;
	accentColor({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const ctx = {
		mode: "tui",
		ui: {
			getEditorComponent: () => current,
			setEditorComponent: (factory: any) => { current = factory; },
		},
	};

	handlers.get("session_start")?.({}, ctx);
	expect(current).not.toBe(previous);
	expect(current({}, {}, {}).borderColor("x")).toContain("x\x1b[39m");

	handlers.get("session_shutdown")?.({}, ctx);
	expect(current).toBe(previous);
});
