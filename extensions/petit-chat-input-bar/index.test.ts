import { expect, test } from "bun:test";
import petitChat from "./index";

test("positions the companion from editor borders and cleans up its compositor hook", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let widgetFactory: any;
	petitChat({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
	const ctx = {
		mode: "tui",
		ui: { setWidget(_key: string, value: any) { widgetFactory = value; } },
	};
	handlers.get("session_start")?.({}, ctx);

	const hidden: boolean[] = [];
	let overlay: any;
	let options: any;
	let hiddenPermanently = false;
	const originalComposite = (lines: string[]) => lines;
	const tui: any = {
		compositeOverlays: originalComposite,
		showOverlay(component: any, overlayOptions: any) {
			overlay = component;
			options = overlayOptions;
			return {
				setHidden(value: boolean) { hidden.push(value); },
				hide() { hiddenPermanently = true; },
			};
		},
	};
	const theme = { fg: (_color: string, text: string) => text };
	const host = widgetFactory(tui, theme);

	expect(options.visible(40, 12)).toBe(true);
	expect(overlay.render(11)).toHaveLength(3);
	const border = "─".repeat(40);
	tui.compositeOverlays(["status", border, "input", border], 40, 12);
	expect(options.row).toBe(0);
	tui.compositeOverlays(["no editor here"], 40, 12);
	expect(hidden.at(-1)).toBe(true);
	tui.compositeOverlays([border, "input", border], 40, 12);
	expect(hidden.at(-1)).toBe(false);

	host.dispose();
	expect(hiddenPermanently).toBe(true);
	expect(tui.compositeOverlays).toBe(originalComposite);
});
