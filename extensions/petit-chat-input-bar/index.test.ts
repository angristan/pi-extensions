import { expect, test } from "bun:test";
import petitChat from "./index";

test("positions the companion from editor borders and cleans up its compositor hook", () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	let widgetFactory: any;
	petitChat({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand() {},
	} as any);
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

test("pauses hidden animation and keeps always mode continuous across agent events", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	let widgetFactory: any;
	petitChat({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	} as any);

	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			setWidget(_key: string, value: any) { widgetFactory = value; },
			notify(message: string) { notifications.push(message); },
		},
	};
	handlers.get("session_start")?.({}, ctx);

	let renders = 0;
	let overlay: any;
	const tui: any = {
		compositeOverlays: (lines: string[]) => lines,
		requestRender() { renders += 1; },
		showOverlay(component: any) {
			overlay = component;
			return { setHidden() {}, hide() {} };
		},
	};
	const theme = { fg: (_color: string, text: string) => text };
	const host = widgetFactory(tui, theme);
	const command = commands.get("petit-chat");
	const border = "─".repeat(40);

	command.handler("", ctx);
	expect(notifications.at(-1)).toBe("Petit Chat animation: smart");

	command.handler("always", ctx);
	await Bun.sleep(180);
	expect(renders).toBe(0);

	tui.compositeOverlays([border, "input", border], 40, 12);
	await Bun.sleep(180);
	expect(renders).toBeGreaterThan(0);
	const poseBeforeAgentStart = overlay.render(11);
	handlers.get("agent_start")?.({}, ctx);
	expect(overlay.render(11)).toEqual(poseBeforeAgentStart);

	tui.compositeOverlays(["no editor here"], 40, 12);
	const rendersWhileHidden = renders;
	await Bun.sleep(180);
	expect(renders).toBe(rendersWhileHidden);

	tui.compositeOverlays([border, "input", border], 40, 12);
	await Bun.sleep(180);
	expect(renders).toBeGreaterThan(rendersWhileHidden);

	command.handler("static", ctx);
	const rendersAfterStatic = renders;
	await Bun.sleep(180);
	expect(renders).toBe(rendersAfterStatic);

	host.dispose();
});

test("smart and working modes follow the agent lifecycle", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	let widgetFactory: any;
	petitChat({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	} as any);

	const ctx = {
		mode: "tui",
		ui: {
			setWidget(_key: string, value: any) { widgetFactory = value; },
			notify() {},
		},
	};
	handlers.get("session_start")?.({}, ctx);

	let renders = 0;
	const tui: any = {
		compositeOverlays: (lines: string[]) => lines,
		requestRender() { renders += 1; },
		showOverlay() { return { setHidden() {}, hide() {} }; },
	};
	const host = widgetFactory(tui, { fg: (_color: string, text: string) => text });
	const border = "─".repeat(40);
	tui.compositeOverlays([border, "input", border], 40, 12);

	handlers.get("agent_start")?.({}, ctx);
	await Bun.sleep(180);
	expect(renders).toBeGreaterThan(0);
	handlers.get("agent_settled")?.({}, ctx);
	const smartIdleRenders = renders;
	await Bun.sleep(180);
	expect(renders).toBe(smartIdleRenders);

	commands.get("petit-chat").handler("working", ctx);
	await Bun.sleep(180);
	expect(renders).toBe(smartIdleRenders);
	handlers.get("agent_start")?.({}, ctx);
	await Bun.sleep(180);
	expect(renders).toBeGreaterThan(smartIdleRenders);

	handlers.get("session_shutdown")?.({}, ctx);
	const rendersAfterShutdown = renders;
	await Bun.sleep(180);
	expect(renders).toBe(rendersAfterShutdown);

	host.dispose();
});
