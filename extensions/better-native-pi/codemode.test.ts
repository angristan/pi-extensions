import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import codemode, { renderCodemodeBlock, type CodemodeCall, type CodemodeView } from "./codemode.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, ""));

function bashCall(reasoning: string, status: CodemodeCall["status"] = "ok", extra: Partial<CodemodeCall> = {}): CodemodeCall {
	return { name: "bash", args: JSON.stringify({ reasoning, command: "git log" }), status, durationMs: 12, ...extra };
}

function view(overrides: Partial<CodemodeView> = {}): CodemodeView {
	return { code: "return 1;", partial: false, error: false, expanded: false, elapsedMs: 0, ...overrides };
}

function settled(text: string, calls: CodemodeCall[], ok = true) {
	return {
		content: [
			{ type: "text", text: `Script ${ok ? "completed" : "failed"}\nWall time 0.3 seconds\nOutput:\n` },
			{ type: "text", text },
		],
		details: { calls },
	};
}

describe("codemode block", () => {
	test("shows the script, grouped calls, and output without Pi's result header", () => {
		const calls = [bashCall("collect repo stats"), bashCall("collect repo stats"), bashCall("read readme")];
		const lines = strip(renderCodemodeBlock(view({ code: "const a = 1;\nreturn a;", result: settled("| a | b |", calls) }), 80, theme));

		expect(lines[0]).toBe("• Ran script · 3 calls in 300ms ✓");
		expect(lines.some((line) => line.includes("const a = 1;"))).toBe(true);
		expect(lines).toContain("  ├ bash collect repo stats ×2 · ✓");
		expect(lines).toContain("  └ bash read readme · 12ms ✓");
		expect(lines.at(-1)).toBe("  │ | a | b |");
		expect(lines.join("\n")).not.toContain("Wall time");
	});

	test("marks failed scripts and shows call errors when expanded", () => {
		const calls = [bashCall("fetch index", "error", { error: "exit 2" })];
		const result = { ...settled("Script error:\nboom", calls, false), isError: true };
		const collapsed = strip(renderCodemodeBlock(view({ result, error: true }), 80, theme));
		const expanded = strip(renderCodemodeBlock(view({ result, error: true, expanded: true }), 80, theme));

		expect(collapsed[0]).toBe("• Ran script · 1 call in 300ms ✗");
		expect(collapsed).toContain("  └ bash fetch index · 12ms ✗");
		expect(collapsed.join("\n")).not.toContain("exit 2");
		expect(expanded).toContain("      exit 2");
	});

	test("shows running calls and elapsed time while partial, without output rows", () => {
		const result = { content: [], details: { calls: [bashCall("scan shard", "running", { durationMs: undefined })] } };
		const lines = strip(renderCodemodeBlock(view({ partial: true, elapsedMs: 2_000, result }), 80, theme));

		expect(lines[0]).toBe("• Running script · 1 call · 2s");
		expect(lines.at(-1)).toBe("  └ bash scan shard · …");
	});

	test("labels calls whose reasoning Pi truncated away with the redacted command", () => {
		// Mirrors Pi's preview: JSON.stringify(args) cut to 197 chars plus "...".
		const full = JSON.stringify({
			command: `AWS_SECRET_ACCESS_KEY='sbXD5/jtw' aws s3 ls --endpoint-url "https://x" ${"a".repeat(200)}`,
			reasoning: "list buckets",
		});
		const calls = [{ name: "bash", args: `${full.slice(0, 197)}...`, status: "ok" as const, durationMs: 5 }];
		const text = strip(renderCodemodeBlock(view({ result: settled("", calls) }), 300, theme)).join("\n");

		expect(text).toContain(`bash AWS_SECRET_ACCESS_KEY=*** aws s3 ls --endpoint-url "https://x" aaa`);
		expect(text).toContain("a… · 5ms ✓");
		expect(text).not.toContain("sbXD5");
		expect(text).not.toContain('{"command"');
	});

	test("hides the options pragma only while collapsed", () => {
		const code = '// @options: {"timeout_ms": 1000}\nreturn 1;';
		const collapsed = strip(renderCodemodeBlock(view({ code }), 80, theme)).join("\n");
		const expanded = strip(renderCodemodeBlock(view({ code, expanded: true }), 80, theme)).join("\n");

		expect(collapsed).not.toContain("@options");
		expect(collapsed).toContain("return 1;");
		expect(expanded).toContain("@options");
	});

	test("collapses long call lists and keeps every row within the width", () => {
		const calls = Array.from({ length: 20 }, (_, index) => bashCall(`step ${index} with a long explanation that wraps`));
		const lines = renderCodemodeBlock(view({ result: settled("x".repeat(300), calls) }), 40, theme);

		expect(strip(lines)).toContain("  ├ … +15 earlier calls (Ctrl+O)");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("codemode registration", () => {
	function fakePi(sourcePath: string | undefined) {
		const handlers: Record<string, () => void> = {};
		const registered: any[] = [];
		const pi: any = {
			on: (event: string, handler: () => void) => { handlers[event] = handler; },
			getAllTools: () => sourcePath ? [{ name: "codemode", sourceInfo: { path: sourcePath } }] : [],
			registerTool: (definition: any) => registered.push(definition),
		};
		return { pi, handlers, registered };
	}
	const create = () => (pi: any) => pi.registerTool({ name: "codemode", execute: () => "ran" });

	test("re-registers Pi's built-in tool with our renderers once per session start", () => {
		const { pi, handlers, registered } = fakePi("builtin:codemode");
		codemode(pi, create);
		expect(registered).toHaveLength(0);
		handlers.session_start!();
		handlers.session_start!();

		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({ name: "codemode", renderShell: "self" });
		expect(registered[0].execute()).toBe("ran");
	});

	test("leaves disabled or third-party codemode tools alone", () => {
		for (const source of [undefined, "/ext/other-codemode.ts"]) {
			const { pi, handlers, registered } = fakePi(source);
			codemode(pi, create);
			handlers.session_start!();
			expect(registered).toHaveLength(0);
		}
	});
});
