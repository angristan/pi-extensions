import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";

const HOST_WIDGET_KEY = "petit-chat-overlay-host";
const CHAT_WIDTH = 11;
const CHAT_HEIGHT = 3;
const GEOMETRY_HOOK_KEY = Symbol.for("pi.petit-chat.current-frame-geometry");

// Vibe's petit chat in its neutral pose. It stays static because periodic TUI
// renders reset Pi's scrollback viewport to the bottom.
const PETIT_CHAT = [
	"  ⡠⣒⠄  ⡔⢄⠔⡄",
	" ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣",
	"  ⠉⠒⠣⠤⠵⠤⠬⠮⠆",
] as const;

type GeometryListener = (lines: string[], termWidth: number, termHeight: number) => void;
type CompositeOverlays = (lines: string[], termWidth: number, termHeight: number) => string[];

interface GeometryHookState {
	original: CompositeOverlays;
	wrapper: CompositeOverlays;
	listeners: Set<GeometryListener>;
}

interface TuiRuntime {
	compositeOverlays?: CompositeOverlays;
	[key: symbol]: unknown;
}

class PetitChatOverlay implements Component {
	private borderPrefix: string;

	constructor(private readonly theme: Theme) {
		this.borderPrefix = theme.fg("borderMuted", "──");
	}

	setBorderPrefix(prefix: string): void {
		this.borderPrefix = prefix;
	}

	render(width: number): string[] {
		return PETIT_CHAT.map((line, index) => {
			if (index === PETIT_CHAT.length - 1) {
				// The feet share the editor border row. Preserve the border through
				// the artwork's two leading blank cells, then draw the exact Vibe
				// glyphs unchanged.
				const merged = this.borderPrefix + this.theme.fg("text", line.slice(2));
				return truncateToWidth(merged, width, "");
			}
			return truncateToWidth(this.theme.fg("text", line), width, "");
		});
	}

	invalidate(): void {
		// Colors are resolved during render, so there is no cached themed state.
	}
}

class PetitChatOverlayHost implements Component {
	private readonly overlay: PetitChatOverlay;
	private readonly handle: OverlayHandle;
	private readonly uninstallGeometryHook: () => void;
	private readonly options: OverlayOptions = {
		nonCapturing: true,
		anchor: "bottom-right",
		width: CHAT_WIDTH,
		maxHeight: CHAT_HEIGHT,
		// Keep a small horizontal inset, but no bottom margin: Pi applies margins
		// as hard clamps even when an explicit editor-relative row is provided.
		margin: { right: 2 },
		visible: (termWidth, termHeight) =>
			this.geometrySupported && termWidth >= 32 && termHeight >= 10,
	};
	private disposed = false;
	private geometrySupported = false;
	private overlayHidden = false;

	constructor(
		private readonly tui: TUI,
		theme: Theme,
	) {
		this.overlay = new PetitChatOverlay(theme);
		const uninstallGeometryHook = installGeometryHook(tui, (lines, width, height) => {
			this.syncPosition(lines, width, height);
		});
		this.geometrySupported = uninstallGeometryHook !== undefined;
		this.uninstallGeometryHook = uninstallGeometryHook ?? (() => {});
		this.handle = tui.showOverlay(this.overlay, this.options);
	}

	render(): string[] {
		// The host only owns the overlay lifecycle and consumes no layout rows.
		return [];
	}

	invalidate(): void {
		this.overlay.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.handle.hide();
		this.uninstallGeometryHook();
	}

	private syncPosition(lines: string[], termWidth: number, termHeight: number): void {
		// `lines` is Pi's complete current frame before overlays are composited.
		// This means editor height changes—including multiline input—are reflected
		// immediately, without a corrective render or one-frame jump.
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
			this.setOverlayHidden(true);
			return;
		}

		this.setOverlayHidden(false);
		const editorTopRow = editorTopLogicalRow - viewportStart;
		// Sample two cells from the current border itself. This preserves Pi's
		// live ANSI color when the thinking level changes the editor border.
		this.overlay.setBorderPrefix(sliceByColumn(lines[editorTopLogicalRow]!, 0, 2, true));
		// Share the final cat row with the editor's horizontal border. The
		// artwork stays intact while its feet visually sit on the line.
		this.options.row = Math.max(0, editorTopRow - CHAT_HEIGHT + 1);
	}

	private setOverlayHidden(hidden: boolean): void {
		if (this.overlayHidden === hidden) return;
		this.overlayHidden = hidden;
		this.handle.setHidden(hidden);
	}
}

function installGeometryHook(tui: TUI, listener: GeometryListener): (() => void) | undefined {
	const runtime = tui as unknown as TuiRuntime;
	let state = runtime[GEOMETRY_HOOK_KEY] as GeometryHookState | undefined;

	// `compositeOverlays` is a private Pi API. Fail closed if a future Pi
	// version removes it or changes it to a non-callable value.
	if (!state && typeof runtime.compositeOverlays !== "function") return undefined;

	// Reuse one shared dispatcher. If another extension wraps the compositor
	// after this one, our wrapper remains in that call chain and can be reused
	// across reloads without adding another dormant layer.
	if (!state) {
		const original = runtime.compositeOverlays!;
		const listeners = new Set<GeometryListener>();
		const wrapper: CompositeOverlays = (lines, termWidth, termHeight) => {
			for (const current of [...listeners]) {
				try {
					current(lines, termWidth, termHeight);
				} catch {
					// This code runs inside Pi's render loop, outside the normal
					// extension error boundary. Disable a failing listener so the
					// original compositor always remains usable.
					listeners.delete(current);
				}
			}
			return original.call(runtime, lines, termWidth, termHeight);
		};
		state = { original, wrapper, listeners };
		runtime[GEOMETRY_HOOK_KEY] = state;
		runtime.compositeOverlays = wrapper;
	}

	state.listeners.add(listener);
	const installedState = state;
	return () => {
		installedState.listeners.delete(listener);
		if (installedState.listeners.size > 0) return;
		if (runtime.compositeOverlays !== installedState.wrapper) return;

		runtime.compositeOverlays = installedState.original;
		if (runtime[GEOMETRY_HOOK_KEY] === installedState) {
			delete runtime[GEOMETRY_HOOK_KEY];
		}
	};
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
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setWidget(
			HOST_WIDGET_KEY,
			(tui, theme) => new PetitChatOverlayHost(tui, theme),
			{ placement: "aboveEditor" },
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(HOST_WIDGET_KEY, undefined);
	});
}
