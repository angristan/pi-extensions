import { expect, test } from "bun:test";
import transcript from "./index";
import { resolveTranscriptOverlayHeight, TranscriptPager } from "./pager";

test("opens a cleaned scrollable transcript from both command and shortcut", async () => {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	transcript({
		registerCommand: (name: string, options: any) => commands.set(name, options),
		registerShortcut: (key: string, options: any) => shortcuts.set(key, options),
	} as any);
	let component: any;
	let overlayOptions: any;
	let closed = false;
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		sessionManager: { getBranch: () => [
			{ type: "message", message: { role: "user", content: "hello<!-- pi:web-search-source:x --> world" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "considering" },
						{ type: "text", text: "answer" },
						{ type: "toolCall", name: "read", arguments: { reasoning: "Inspect code", path: "src/index.ts" } },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false } },
			{ type: "custom_message", display: false, content: "hidden" },
		] },
		ui: {
			custom: async (factory: any, options: any) => {
				overlayOptions = options;
				component = factory({ terminal: { rows: 100 }, requestRender() {} }, theme, {}, () => { closed = true; });
			},
		},
	};

	expect(shortcuts.has("ctrl+shift+t")).toBe(true);
	await commands.get("transcript").handler("", ctx);
	const renderedLines = component.render(80);
	expect(renderedLines).toHaveLength(92);
	const rendered = renderedLines.join("\n");
	expect(rendered).toContain("› User\n  hello world");
	expect(rendered).toContain("· Thinking\n  considering");
	expect(rendered).toContain("● Agent\n  answer");
	expect(rendered).toContain("◆ Tool · read\n  Inspect code\n  path  src/index.ts");
	expect(rendered).toContain("✓ Tool result · read\n  file contents");
	expect(rendered).not.toContain("pi:web-search");
	expect(rendered).not.toContain("hidden");
	expect(overlayOptions.overlay).toBe(true);
	component.handleInput("q");
	expect(closed).toBe(true);
});

test("resolved pager height matches the percentage and margin overlay budget", () => {
	expect(resolveTranscriptOverlayHeight(24)).toBe(22);
	expect(resolveTranscriptOverlayHeight(25)).toBe(23);
	expect(resolveTranscriptOverlayHeight(26)).toBe(23);
	expect(resolveTranscriptOverlayHeight(100)).toBe(92);
	expect(resolveTranscriptOverlayHeight(200)).toBe(184);

	const entries = Array.from({ length: 120 }, (_, index) => ({
		type: "message",
		message: { role: "assistant", content: `row-${index}` },
	}));
	const theme = { fg: (_color: string, text: string) => text };
	for (const terminalRows of [1, 2, 3, 24, 25, 26, 100, 200]) {
		const pager = new TranscriptPager(() => entries, theme, () => {}, () => {}, {
			startAtEnd: true,
			maxHeight: () => resolveTranscriptOverlayHeight(terminalRows),
		});
		const rendered = pager.render(80);
		expect(rendered).toHaveLength(resolveTranscriptOverlayHeight(terminalRows));
		if (rendered.length > 2) expect(rendered.join("\n")).toContain("row-119");
	}
});

test("reusable transcript pager follows appended entries", () => {
	const entries = Array.from({ length: 30 }, (_, index) => ({
		type: "message",
		message: { role: "assistant", content: `row-${index}` },
	}));
	const theme = { fg: (_color: string, text: string) => text };
	const pager = new TranscriptPager(() => entries, theme, () => {}, () => {}, {
		title: "Agent transcript",
		startAtEnd: true,
	});

	const initial = pager.render(80).join("\n");
	expect(initial).toContain("Agent transcript");
	expect(initial).toContain("row-29");
	expect(initial).not.toContain("row-0\n");

	entries.push({ type: "message", message: { role: "assistant", content: "latest-live-row" } });
	pager.invalidate();
	expect(pager.render(80).join("\n")).toContain("latest-live-row");

	pager.handleInput("\x1b[A");
	entries.push({ type: "message", message: { role: "assistant", content: "paused-tail-row" } });
	pager.invalidate();
	expect(pager.render(80).join("\n")).not.toContain("paused-tail-row");

	pager.handleInput("\x1b[F");
	expect(pager.render(80).join("\n")).toContain("paused-tail-row");
});
