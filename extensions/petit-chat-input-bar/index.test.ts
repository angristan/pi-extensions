import { expect, test } from "bun:test";
import petitChat from "./index";

test("removes inactive overlays and recreates them when editor geometry returns", () => {
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

	let overlay: any;
	let options: any;
	let overlayShows = 0;
	let overlayHides = 0;
	const overlayEntries = new Set<object>();
	let frameLines = ["no editor here"];
	const originalRender = () => frameLines;
	const tui: any = {
		mode: "regular",
		terminal: { columns: 40, rows: 12 },
		render: originalRender,
		showOverlay(component: any, overlayOptions: any) {
			overlayShows += 1;
			overlay = component;
			options = overlayOptions;
			const entry = {};
			overlayEntries.add(entry);
			return {
				hide() {
					if (overlayEntries.delete(entry)) overlayHides += 1;
				},
			};
		},
	};
	const theme = { fg: (_color: string, text: string) => text };
	const host = widgetFactory(tui, theme);

	// Mounting and an inactive frame leave no dormant overlay entry.
	expect(overlayEntries.size).toBe(0);
	tui.render(40);
	expect(overlayEntries.size).toBe(0);
	expect(overlayShows).toBe(0);

	// A later editor frame creates the overlay when it is needed.
	const border = "─".repeat(40);
	frameLines = ["status", border, "input", border];
	tui.render(40);
	expect(options.visible(40, 12)).toBe(true);
	expect(options.row).toBe(0);
	expect(overlay.render(11)).toHaveLength(3);
	expect(overlayEntries.size).toBe(1);
	expect(overlayShows).toBe(1);

	frameLines = ["no editor here"];
	tui.render(40);
	expect(overlayEntries.size).toBe(0);
	expect(overlayHides).toBe(1);
	frameLines = [border, "input", border];
	tui.render(40);
	expect(overlayEntries.size).toBe(1);
	expect(overlayShows).toBe(2);

	host.dispose();
	expect(overlayEntries.size).toBe(0);
	expect(tui.render).toBe(originalRender);
});

test("does not recurse through Pi's forwarding TUI reference", () => {
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

	let renderCalls = 0;
	class Renderer {
		mode = "regular";
		terminal = { columns: 40, rows: 12 };
		render(): string[] {
			renderCalls += 1;
			const border = "─".repeat(40);
			return [border, "input", border];
		}
		showOverlay() {
			return { hide() {} };
		}
	}
	const renderer = new Renderer();
	const tui = new Proxy({} as any, {
		get: (_target, property) => {
			const value = Reflect.get(renderer, property, renderer);
			if (typeof value !== "function") return value;
			return (...args: any[]) => Reflect.apply(Reflect.get(renderer, property, renderer), renderer, args);
		},
		set: (_target, property, value) => Reflect.set(renderer, property, value, renderer),
		getPrototypeOf: () => Reflect.getPrototypeOf(renderer),
	});

	const host = widgetFactory(tui, { fg: (_color: string, text: string) => text });
	const border = "─".repeat(40);
	expect(tui.render(40)).toEqual([border, "input", border]);
	expect(renderCalls).toBe(1);

	host.dispose();
	expect(tui.render(40)).toEqual([border, "input", border]);
	expect(renderCalls).toBe(2);
});

test("reinstalls geometry tracking and recreates the overlay after a mode switch", () => {
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

	const border = "─".repeat(40);
	class Renderer {
		mode: "regular" | "fullscreen" = "regular";
		terminal = { columns: 40, rows: 12 };
		frameLines = ["no editor"];
		overlayEntries = 0;
		render(): string[] { return this.frameLines; }
		compositeOverlays(lines: string[]): string[] { return lines; }
		requestRender() {}
		showOverlay() {
			this.overlayEntries += 1;
			let hidden = false;
			return {
				hide: () => {
					if (hidden) return;
					hidden = true;
					this.overlayEntries -= 1;
				},
			};
		}
	}
	let renderer = new Renderer();
	const tui = new Proxy({} as any, {
		get: (_target, property) => {
			const owner = renderer;
			const value = Reflect.get(owner, property, owner);
			if (typeof value !== "function") return value;
			return (...args: any[]) => {
				const current = renderer;
				return Reflect.apply(Reflect.get(current, property, current), current, args);
			};
		},
		set: (_target, property, value) => Reflect.set(renderer, property, value, renderer),
		getPrototypeOf: () => Reflect.getPrototypeOf(renderer),
	});
	const host = widgetFactory(tui, { fg: (_color: string, text: string) => text });

	renderer.frameLines = [border, "input", border];
	tui.render(40);
	expect(renderer.overlayEntries).toBe(1);
	renderer.frameLines = ["no editor"];
	tui.render(40);
	expect(renderer.overlayEntries).toBe(0);

	const fullscreen = new Renderer();
	fullscreen.mode = "fullscreen";
	fullscreen.frameLines = [border, "input", border];
	renderer = fullscreen;
	host.render();
	tui.compositeOverlays(fullscreen.frameLines, 40, 12);
	expect(fullscreen.overlayEntries).toBe(1);

	host.dispose();
	expect(fullscreen.overlayEntries).toBe(0);
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
	let frameLines = ["no editor here"];
	const tui: any = {
		mode: "regular",
		terminal: { columns: 40, rows: 12 },
		render: () => frameLines,
		requestRender() { renders += 1; },
		showOverlay(component: any) {
			overlay = component;
			return { hide() {} };
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

	frameLines = [border, "input", border];
	tui.render(40);
	await Bun.sleep(180);
	expect(renders).toBeGreaterThan(0);
	const poseBeforeAgentStart = overlay.render(11);
	handlers.get("agent_start")?.({}, ctx);
	expect(overlay.render(11)).toEqual(poseBeforeAgentStart);

	frameLines = ["no editor here"];
	tui.render(40);
	const rendersWhileHidden = renders;
	await Bun.sleep(180);
	expect(renders).toBe(rendersWhileHidden);

	frameLines = [border, "input", border];
	tui.render(40);
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
	const border = "─".repeat(40);
	const tui: any = {
		mode: "regular",
		terminal: { columns: 40, rows: 12 },
		render: () => [border, "input", border],
		requestRender() { renders += 1; },
		showOverlay() { return { hide() {} }; },
	};
	const host = widgetFactory(tui, { fg: (_color: string, text: string) => text });
	tui.render(40);

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
