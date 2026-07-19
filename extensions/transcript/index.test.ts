import { expect, test } from "bun:test";
import transcript from "./index";
import { TranscriptPager } from "./pager";

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
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "considering" }, { type: "text", text: "answer" }] } },
			{ type: "custom_message", display: false, content: "hidden" },
		] },
		ui: {
			custom: async (factory: any, options: any) => {
				overlayOptions = options;
				component = factory({ requestRender() {} }, theme, {}, () => { closed = true; });
			},
		},
	};

	expect(shortcuts.has("ctrl+shift+t")).toBe(true);
	await commands.get("transcript").handler("", ctx);
	const rendered = component.render(80).join("\n");
	expect(rendered).toContain("hello world");
	expect(rendered).toContain("considering\n  answer");
	expect(rendered).not.toContain("pi:web-search");
	expect(rendered).not.toContain("hidden");
	expect(overlayOptions.overlay).toBe(true);
	component.handleInput("q");
	expect(closed).toBe(true);
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
