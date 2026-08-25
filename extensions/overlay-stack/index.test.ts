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
		showOverlay() {
			overlayShows += 1;
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
		title: () => "Test",
		renderBody: () => ["body"],
	});

	return {
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

test("Ctrl+Shift+O and /overlay remove and recreate the overlay stack", () => {
	const harness = makeHarness();
	try {
		expect(harness.shortcuts.has("ctrl+shift+o")).toBe(true);
		expect(harness.commands.has("overlay")).toBe(true);
		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.overlayShows).toBe(1);

		harness.shortcuts.get("ctrl+shift+o").handler(harness.ctx);
		expect(harness.overlayEntries.size).toBe(0);
		expect(harness.overlayHides).toBe(1);
		expect(harness.notifications.at(-1)).toBe("Overlay hidden");

		harness.commands.get("overlay").handler("", harness.ctx);
		expect(harness.overlayEntries.size).toBe(1);
		expect(harness.overlayShows).toBe(2);
		expect(harness.notifications.at(-1)).toBe("Overlay shown");
	} finally {
		harness.cleanup();
	}
});

test("closing a modal does not reveal a manually hidden overlay", () => {
	const harness = makeHarness();
	try {
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
