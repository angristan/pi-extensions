import { expect, test } from "bun:test";
import overlayStack from "./index";

function makeHarness() {
	const lifecycle = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	let modalListener: ((event: unknown) => void) | undefined;
	let widgetFactory: ((tui: any, theme: any) => any) | undefined;
	const hiddenStates: boolean[] = [];
	const notifications: string[] = [];

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
		requestRender() {},
		showOverlay() {
			return {
				hide() {},
				setHidden(hidden: boolean) { hiddenStates.push(hidden); },
			};
		},
	};

	lifecycle.get("session_start")?.({}, ctx);
	widgetFactory?.(tui, {});

	return { commands, shortcuts, modal: (event: unknown) => modalListener?.(event), ctx, hiddenStates, notifications };
}

test("Alt+O and /overlay toggle the overlay stack", () => {
	const harness = makeHarness();

	expect(harness.shortcuts.has("alt+o")).toBe(true);
	expect(harness.commands.has("overlay")).toBe(true);

	harness.shortcuts.get("alt+o").handler(harness.ctx);
	expect(harness.hiddenStates.at(-1)).toBe(true);
	expect(harness.notifications.at(-1)).toBe("Overlay hidden");

	harness.commands.get("overlay").handler("", harness.ctx);
	expect(harness.hiddenStates.at(-1)).toBe(false);
	expect(harness.notifications.at(-1)).toBe("Overlay shown");
});

test("closing a modal does not reveal a manually hidden overlay", () => {
	const harness = makeHarness();

	harness.shortcuts.get("alt+o").handler(harness.ctx);
	harness.modal({ id: "context", hidden: true });
	harness.modal({ id: "context", hidden: false });

	expect(harness.hiddenStates.at(-1)).toBe(true);
});
