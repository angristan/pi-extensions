import { expect, test } from "bun:test";
import overlayStack, { registerOverlayCard } from "./index";

let nextCardId = 0;

function makeHarness() {
	const lifecycle = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	let modalListener: ((event: unknown) => void) | undefined;
	let widgetFactory: ((tui: any, theme: any) => any) | undefined;
	const notifications: string[] = [];
	const overlayEntries = new Set<object>();
	let overlayShows = 0;
	let overlayHides = 0;
	let overlay: { component: any; options: any } | undefined;

	overlayStack({
		events: {
			on(_name: string, listener: (event: unknown) => void) {
				modalListener = listener;
				return () => { modalListener = undefined; };
			},
		},
		on(name: string, handler: (...args: any[]) => any) {
			lifecycle.set(name, handler);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		registerShortcut(key: string, options: any) {
			shortcuts.set(key, options);
		},
	} as any);

	const ctx = {
		mode: "tui",
		ui: {
			notify(message: string) { notifications.push(message); },
			setWidget(_key: string, factory: ((tui: any, theme: any) => any) | undefined) {
				widgetFactory = factory;
			},
		},
	};
	const tui = {
		terminal: { columns: 100, rows: 30 },
		requestRender() {},
		showOverlay(component: any, options: any) {
			overlayShows += 1;
			overlay = { component, options };
			const entry = {};
			overlayEntries.add(entry);
			return {
				hide() {
					if (overlayEntries.delete(entry)) overlayHides += 1;
				},
			};
		},
	};

	lifecycle.get("session_start")?.({}, ctx);
	const host = widgetFactory?.(tui, {});
	const card = registerOverlayCard({
		id: `overlay-stack-test-${nextCardId++}`,
		order: 0,
		width: 20,
		minBodyHeight: 1,
		visible: () => true,
		title: () => " Test ",
		compactTitle: () => " Test 1/2 ",
		renderBody: () => ["body"],
	});

	// Render the way the TUI does: visible() updates the width, then render().
	const renderOverlay = () => {
		if (!overlay) return undefined;
		overlay.options.visible(tui.terminal.columns, tui.terminal.rows);
		return { width: overlay.options.width, lines: overlay.component.render(overlay.options.width) as string[] };
	};

	return {
		renderOverlay,
		commands,
		shortcuts,
		modal: (event: unknown) => modalListener?.(event),
		ctx,
		host,
		card,
		notifications,
		overlayEntries,
		get overlayShows() { return overlayShows; },
		get overlayHides() { return overlayHides; },
		cleanup() {
			card.unregister();
			lifecycle.get("session_shutdown")?.({}, ctx);
		},
	};
}

test("Ctrl+Shift+O and /overlay cycle shown, compact, and hidden", () => {
	const harness = makeHarness();
	try {
		expect(harness.shortcuts.has("ctrl+shift+o")).toBe(true);
		expect(harness.commands.has("overlay")).toBe(true);
		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.overlayShows).toBe(1);
		const full = harness.renderOverlay()!;
		expect(full.width).toBe(20);
		expect(full.lines.join("\n")).toContain("body");

		// Compact keeps the same overlay entry and shrinks it to title-only cards.
		harness.shortcuts.get("ctrl+shift+o").handler(harness.ctx);
		expect(harness.notifications.at(-1)).toBe("Overlay compact");
		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.overlayShows).toBe(1);
		const compact = harness.renderOverlay()!;
		expect(compact.width).toBe(" Test 1/2 ".length + 2);
		expect(compact.lines).toHaveLength(2);
		expect(compact.lines[0]).toContain(" Test 1/2 ");
		expect(compact.lines.join("\n")).not.toContain("body");

		harness.shortcuts.get("ctrl+shift+o").handler(harness.ctx);
		expect(harness.overlayEntries.size).toBe(0);
		expect(harness.overlayHides).toBe(1);
		expect(harness.notifications.at(-1)).toBe("Overlay hidden");

		harness.commands.get("overlay").handler("", harness.ctx);
		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.overlayShows).toBe(2);
		expect(harness.notifications.at(-1)).toBe("Overlay shown");
		expect(harness.renderOverlay()!.lines.join("\n")).toContain("body");
	} finally {
		harness.cleanup();
	}
});

test("closing a modal restores compact mode instead of the full stack", () => {
	const harness = makeHarness();
	try {
		harness.shortcuts.get("ctrl+shift+o").handler(harness.ctx);
		harness.modal({ id: "context", hidden: true });
		expect(harness.overlayEntries.size).toBe(0);
		harness.modal({ id: "context", hidden: false });

		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.renderOverlay()!.lines).toHaveLength(2);
	} finally {
		harness.cleanup();
	}
});

test("closing a modal does not reveal a manually hidden overlay", () => {
	const harness = makeHarness();
	try {
		harness.shortcuts.get("ctrl+shift+o").handler(harness.ctx);
		harness.shortcuts.get("ctrl+shift+o").handler(harness.ctx);
		harness.modal({ id: "context", hidden: true });
		harness.modal({ id: "context", hidden: false });

		expect(harness.overlayEntries.size).toBe(0);
		expect(harness.overlayShows).toBe(1);
	} finally {
		harness.cleanup();
	}
});

test("inactive cards leave no overlay entry and can recreate it", () => {
	const harness = makeHarness();
	let inactiveCard: ReturnType<typeof registerOverlayCard> | undefined;
	try {
		expect(harness.overlayEntries.size).toBe(1);

		let visible = false;
		inactiveCard = registerOverlayCard({
			id: `overlay-stack-inactive-${nextCardId++}`,
			order: 0,
			width: 20,
			minBodyHeight: 1,
			visible: () => visible,
			title: () => "Inactive",
			renderBody: () => ["body"],
		});
		// Replace the harness card so the registry has no visible cards.
		harness.card.unregister();
		expect(harness.overlayEntries.size).toBe(0);

		visible = true;
		inactiveCard.invalidate();
		harness.host?.render(100);
		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.overlayShows).toBe(2);

	} finally {
		inactiveCard?.unregister();
		harness.cleanup();
	}
});
