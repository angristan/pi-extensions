import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	FRAME_DURATION_MS,
	parseAnimationMode,
	pickRandomDelay,
	SMART_IDLE_DELAY_MS,
	SMART_WORKING_DELAY_MS,
	type AnimationMode,
} from "./animation";
import {
	CHAT_HEIGHT,
	CHAT_WIDTH,
	getPetitChatPose,
	PETIT_CHAT_FRAME_SEQUENCE,
} from "./frames";

const HOST_WIDGET_KEY = "petit-chat-overlay-host";
const GEOMETRY_HOOK_KEY = Symbol.for("pi.petit-chat.current-frame-geometry.v2");

type GeometryListener = (lines: string[], termWidth: number, termHeight: number) => void;
type CompositeOverlays = (lines: string[], termWidth: number, termHeight: number) => string[];
type RenderFrame = (width: number) => string[];
type GeometryHookMethod = "render" | "compositeOverlays";

interface GeometryHookState {
	method: GeometryHookMethod;
	original: CompositeOverlays | RenderFrame;
	wrapper: CompositeOverlays | RenderFrame;
	listeners: Set<GeometryListener>;
	canRestore: boolean;
}

interface TuiRuntime {
	mode?: "regular" | "fullscreen";
	terminal?: { rows: number };
	render?: RenderFrame;
	compositeOverlays?: CompositeOverlays;
	[key: symbol]: unknown;
}

class PetitChatOverlay implements Component {
	private borderPrefix: string;
	private frameIndex = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private visible = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private mode: AnimationMode,
		private working: boolean,
	) {
		this.borderPrefix = theme.fg("borderMuted", "──");
	}

	setBorderPrefix(prefix: string): void {
		this.borderPrefix = prefix;
	}

	setBehavior(mode: AnimationMode, working: boolean): void {
		const modeChanged = this.mode !== mode;
		const workingChanged = this.working !== working;
		const reactsToWorking = mode === "smart" || mode === "working";
		const becameWorking = !this.working && working;
		this.mode = mode;
		this.working = working;

		if (!modeChanged && (!reactsToWorking || !workingChanged)) return;

		this.cancelTimer();
		this.resetFrame();
		if (this.visible) this.schedulePolicy(mode === "smart" && (becameWorking || working));
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.cancelTimer();
		this.resetFrame();
		if (visible) this.schedulePolicy(this.mode === "smart" && this.working);
	}

	render(width: number): string[] {
		const pose = getPetitChatPose(this.frameIndex);
		return pose.map((line, index) => {
			if (index === pose.length - 1) {
				// The feet share the editor border row. Preserve the border through
				// the artwork's two leading blank cells, then draw the sprite glyphs.
				const merged = this.borderPrefix + this.theme.fg("text", line.slice(2));
				return truncateToWidth(merged, width, "");
			}
			return truncateToWidth(this.theme.fg("text", line), width, "");
		});
	}

	invalidate(): void {
		// Colors are resolved during render, so there is no cached themed state.
	}

	dispose(): void {
		this.disposed = true;
		this.cancelTimer();
	}

	private schedulePolicy(startSmartImmediately = false): void {
		if (this.disposed || !this.visible) return;

		if (this.mode === "always" || (this.mode === "working" && this.working)) {
			this.scheduleContinuousFrame();
		} else if (this.mode === "smart") {
			if (startSmartImmediately) this.scheduleSmartFrame();
			else this.scheduleSmartCycle();
		}
	}

	private scheduleContinuousFrame(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.frameIndex = (this.frameIndex + 1) % PETIT_CHAT_FRAME_SEQUENCE.length;
			this.tui.requestRender();
			this.schedulePolicy();
		}, FRAME_DURATION_MS);
	}

	private scheduleSmartFrame(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.frameIndex += 1;

			if (this.frameIndex >= PETIT_CHAT_FRAME_SEQUENCE.length - 1) {
				this.frameIndex = 0;
				this.tui.requestRender();
				this.scheduleSmartCycle();
				return;
			}

			this.tui.requestRender();
			this.scheduleSmartFrame();
		}, FRAME_DURATION_MS);
	}

	private scheduleSmartCycle(): void {
		const range = this.working ? SMART_WORKING_DELAY_MS : SMART_IDLE_DELAY_MS;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.scheduleSmartFrame();
		}, pickRandomDelay(range));
	}

	private resetFrame(): void {
		if (this.frameIndex === 0) return;
		this.frameIndex = 0;
		if (this.visible) this.tui.requestRender();
	}

	private cancelTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

class PetitChatOverlayHost implements Component {
	private current?: {
		overlay: PetitChatOverlay;
		handle: OverlayHandle;
	};
	private readonly geometryListener: GeometryListener = (lines, width, height) => {
		this.syncPosition(lines, width, height);
	};
	private geometryHookState?: GeometryHookState;
	private uninstallGeometryHook?: () => void;
	private readonly options: OverlayOptions = {
		nonCapturing: true,
		anchor: "bottom-right",
		width: CHAT_WIDTH,
		maxHeight: CHAT_HEIGHT,
		// Keep a small horizontal inset, but no bottom margin: Pi applies margins
		// as hard clamps even when an explicit editor-relative row is provided.
		margin: { right: 2 },
		visible: (termWidth, termHeight) => termWidth >= 32 && termHeight >= 10,
	};
	private disposed = false;
	private mode: AnimationMode;
	private working: boolean;
	private borderPrefix?: string;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		mode: AnimationMode,
		working: boolean,
	) {
		this.mode = mode;
		this.working = working;
		this.ensureGeometryHook();
	}

	render(): string[] {
		// Pi 0.84 can replace the concrete renderer behind this stable TUI
		// reference. Reinstall the guarded private hook on the active renderer.
		// In regular mode this host is already inside the first unwrapped frame,
		// so request one follow-up render for the new hook to observe it.
		if (this.ensureGeometryHook()) this.tui.requestRender();
		return [];
	}

	invalidate(): void {
		this.current?.overlay.invalidate();
	}

	setBehavior(mode: AnimationMode, working: boolean): void {
		this.mode = mode;
		this.working = working;
		this.current?.overlay.setBehavior(mode, working);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeOverlay();
		this.uninstallGeometryHook?.();
		this.uninstallGeometryHook = undefined;
		this.geometryHookState = undefined;
	}

	private ensureGeometryHook(): boolean {
		if (this.disposed) return false;
		const runtime = this.tui as unknown as TuiRuntime;
		const state = runtime[GEOMETRY_HOOK_KEY] as GeometryHookState | undefined;
		if (state?.listeners.has(this.geometryListener)) return false;

		const uninstall = installGeometryHook(this.tui, this.geometryListener);
		const installedState = runtime[GEOMETRY_HOOK_KEY] as GeometryHookState | undefined;
		if (!uninstall || !installedState) {
			this.uninstallGeometryHook?.();
			this.uninstallGeometryHook = undefined;
			this.geometryHookState = undefined;
			return false;
		}

		// A mode switch replaces the concrete renderer behind the proxy. Detach
		// from the discarded renderer before retaining the new registration.
		if (this.geometryHookState !== installedState) this.uninstallGeometryHook?.();
		this.geometryHookState = installedState;
		this.uninstallGeometryHook = uninstall;
		return true;
	}

	private ensureOverlay(): void {
		if (this.current || this.disposed) return;

		// hide() permanently removes an overlay. Recreate both the component and
		// handle so no disposed overlay object crosses a hidden or mode boundary.
		const overlay = new PetitChatOverlay(this.tui, this.theme, this.mode, this.working);
		if (this.borderPrefix !== undefined) overlay.setBorderPrefix(this.borderPrefix);
		const handle = this.tui.showOverlay(overlay, this.options);
		this.current = { overlay, handle };
	}

	private removeOverlay(): void {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		current.overlay.setVisible(false);
		current.overlay.dispose();
		current.handle.hide();
	}

	private syncPosition(lines: string[], termWidth: number, termHeight: number): void {
		// `lines` is Pi's complete current frame before overlays are composited.
		// This means editor height changes—including multiline input—are reflected
		// immediately, without a corrective render or one-frame jump.
		if (termWidth < 32 || termHeight < 10) {
			this.removeOverlay();
			return;
		}

		const viewportStart = Math.max(0, lines.length - termHeight);
		const borderRows: number[] = [];
		for (let row = viewportStart; row < lines.length; row++) {
			const plain = stripTerminalSequences(lines[row] ?? "").trim();
			if (isEditorBorderCandidate(plain, termWidth)) borderRows.push(row);
		}

		// Pi's editor shows at most max(5, floor(rows * 0.3)) content rows,
		// plus its top and bottom borders. Reject wider pairs such as the
		// full-screen /model selector instead of mistaking them for the editor.
		const maxBorderDistance = Math.max(5, Math.floor(termHeight * 0.3)) + 1;
		const editorBottomLogicalRow = borderRows.at(-1);
		let editorTopLogicalRow: number | undefined;
		if (editorBottomLogicalRow !== undefined) {
			for (let index = borderRows.length - 2; index >= 0; index--) {
				const candidate = borderRows[index]!;
				const distance = editorBottomLogicalRow - candidate;
				if (distance >= 2 && distance <= maxBorderDistance) {
					editorTopLogicalRow = candidate;
					break;
				}
				if (distance > maxBorderDistance) break;
			}
		}
		if (editorTopLogicalRow === undefined) {
			this.removeOverlay();
			return;
		}

		this.ensureOverlay();
		const editorTopRow = editorTopLogicalRow - viewportStart;
		// Sample two cells from the current border itself. This preserves Pi's
		// live ANSI color when the thinking level changes the editor border.
		this.borderPrefix = sliceByColumn(lines[editorTopLogicalRow]!, 0, 2, true);
		// Share the final cat row with the editor's horizontal border. The
		// artwork stays intact while its feet visually sit on the line.
		this.options.row = Math.max(0, editorTopRow - CHAT_HEIGHT + 1);
		this.current?.overlay.setBorderPrefix(this.borderPrefix);
		this.current?.overlay.setVisible(true);
	}
}

function installGeometryHook(tui: TUI, listener: GeometryListener): (() => void) | undefined {
	const runtime = tui as unknown as TuiRuntime;
	let state = runtime[GEOMETRY_HOOK_KEY] as GeometryHookState | undefined;
	const method: GeometryHookMethod = runtime.mode === "regular" ? "render" : "compositeOverlays";
	const resolved = state ? undefined : resolveForwardedMethod(runtime, method);

	// These renderer methods are private integration points. Fail closed if a
	// future Pi version removes one or changes it to a non-callable value.
	if (!state && !resolved) return undefined;

	// Regular mode skips compositeOverlays when no entries exist, so observe its
	// base render instead. Fullscreen always calls the compositor. Both hooks run
	// before overlay composition and can add/remove the entry for the same frame.
	if (!state) {
		const { original, canRestore } = resolved!;
		const listeners = new Set<GeometryListener>();
		const notify = (lines: string[], termWidth: number, termHeight: number) => {
			for (const current of [...listeners]) {
				try {
					current(lines, termWidth, termHeight);
				} catch {
					// This runs inside Pi's render loop, outside the normal extension
					// error boundary. Disable a failing listener to protect rendering.
					listeners.delete(current);
				}
			}
		};
		const wrapper: CompositeOverlays | RenderFrame = method === "render"
			? ((width: number) => {
				const lines = (original as RenderFrame).call(runtime, width);
				notify(lines, width, runtime.terminal?.rows ?? 0);
				return lines;
			})
			: ((lines: string[], termWidth: number, termHeight: number) => {
				notify(lines, termWidth, termHeight);
				return (original as CompositeOverlays).call(runtime, lines, termWidth, termHeight);
			});
		state = { method, original, wrapper, listeners, canRestore };
		runtime[GEOMETRY_HOOK_KEY] = state;
		runtime[method] = wrapper as RenderFrame & CompositeOverlays;
	}

	state.listeners.add(listener);
	const installedState = state;
	return () => {
		installedState.listeners.delete(listener);
		if (installedState.listeners.size > 0) return;
		// Pi 0.84 exposes the renderer through a forwarding Proxy. Each method
		// read returns a new function, so wrapper identity cannot be checked.
		// Keep the empty shared dispatcher installed for safe reuse on reload.
		if (!installedState.canRestore) return;
		if (runtime[installedState.method] !== installedState.wrapper) return;

		runtime[installedState.method] = installedState.original as RenderFrame & CompositeOverlays;
		if (runtime[GEOMETRY_HOOK_KEY] === installedState) {
			delete runtime[GEOMETRY_HOOK_KEY];
		}
	};
}

function resolveForwardedMethod(
	runtime: TuiRuntime,
	method: GeometryHookMethod,
): { original: CompositeOverlays | RenderFrame; canRestore: boolean } | undefined {
	const current = runtime[method];
	if (typeof current !== "function") return undefined;

	// Normal TUI objects return a stable method and can be restored by identity.
	if (runtime[method] === current) return { original: current, canRestore: true };

	// Pi's stable TUI reference returns a fresh forwarding closure on every get.
	// Capturing it would recurse after the wrapper becomes the current method.
	// Resolve the concrete class method through the Proxy's forwarded prototype.
	let prototype = Object.getPrototypeOf(runtime);
	while (prototype) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
		if (typeof descriptor?.value === "function") {
			return {
				original: descriptor.value as CompositeOverlays | RenderFrame,
				canRestore: false,
			};
		}
		prototype = Object.getPrototypeOf(prototype);
	}

	return undefined;
}

function isEditorBorderCandidate(value: string, termWidth: number): boolean {
	if (visibleWidth(value) < termWidth - 2) return false;
	return /^─+$/.test(value) || /^─── [↑↓] \d+ more ─*$/.test(value);
}

function stripTerminalSequences(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b_[^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n]/g, "");
}

export default function (pi: ExtensionAPI) {
	let host: PetitChatOverlayHost | undefined;
	let mode: AnimationMode = "smart";
	let working = false;

	const syncAnimation = () => host?.setBehavior(mode, working);
	const statusText = () => `Petit Chat animation: ${mode}`;
	const setMode = (nextMode: AnimationMode, ctx: ExtensionContext) => {
		mode = nextMode;
		syncAnimation();
		ctx.ui.notify(statusText(), "info");
	};

	pi.on("session_start", (_event, ctx) => {
		working = false;
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget(
			HOST_WIDGET_KEY,
			(tui, theme) => {
				host = new PetitChatOverlayHost(tui, theme, mode, working);
				return host;
			},
			{ placement: "aboveEditor" },
		);
	});

	pi.on("agent_start", () => {
		working = true;
		syncAnimation();
	});

	pi.on("agent_settled", () => {
		working = false;
		syncAnimation();
	});

	pi.registerCommand("petit-chat", {
		description: "Set Petit Chat animation to smart, working, always, or static",
		getArgumentCompletions: (prefix) => {
			const commands = ["status", "smart", "working", "always", "static"];
			const items = commands
				.filter((command) => command.startsWith(prefix.trim().toLowerCase()))
				.map((command) => ({ value: command, label: command }));
			return items.length > 0 ? items : null;
		},
		handler: (args, ctx) => {
			const command = parseAnimationMode(args);
			if (!command) {
				ctx.ui.notify("Usage: /petit-chat [status|smart|working|always|static]", "error");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(statusText(), "info");
				return;
			}
			setMode(command, ctx);
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		host?.dispose();
		ctx.ui.setWidget(HOST_WIDGET_KEY, undefined);
		host = undefined;
	});
}
