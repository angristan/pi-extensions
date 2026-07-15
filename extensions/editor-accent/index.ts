import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Default accent: Mistral Vibe's canonical orange (`$mistral_orange` in Vibe's TUI).
export const DEFAULT_ACCENT_HEX = "#FF8205";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "editor-accent.json");

const ANSI_FOREGROUND_RESET = "\x1b[39m";
const ACCENT_BORDER_LOCK = Symbol.for("pi.accent-input-bar.lock");

export type BorderColor = (text: string) => string;

type EditorLike = {
	borderColor?: BorderColor;
	[ACCENT_BORDER_LOCK]?: true;
};

/** Parse a `#RRGGBB` (or `#RGB`) hex color into an RGB triple. */
function hexToRgb(hex: string): [number, number, number] | undefined {
	const match = hex.trim().replace(/^#/, "");
	const long = match.match(/^([0-9a-f]{6})$/i);
	if (long) {
		return [parseInt(long[1].slice(0, 2), 16), parseInt(long[1].slice(2, 4), 16), parseInt(long[1].slice(4, 6), 16)];
	}
	const short = match.match(/^([0-9a-f]{3})$/i);
	if (short) {
		return [parseInt(short[1][0]! + short[1][0], 16), parseInt(short[1][1]! + short[1][1], 16), parseInt(short[1][2]! + short[1][2], 16)];
	}
	return undefined;
}

/**
 * Resolve the accent color used for the editor border (and the plan-progress
 * box). Override via `~/.pi/agent/editor-accent.json`:
 *
 *   { "color": "#FF8205" }
 *
 * Accepts any `#RRGGBB` / `#RGB` hex. Defaults to Vibe orange (#FF8205).
 */
let cachedAnsi: string | undefined;
let configReadAt = 0;
const CONFIG_TTL_MS = 5_000;

function accentAnsi(): string {
	// Cache the ANSI escape briefly so per-keystroke border renders don't re-read
	// the file on every call, while still picking up edits + /reload within ~5s.
	if (cachedAnsi && Date.now() - configReadAt < CONFIG_TTL_MS) return cachedAnsi;
	configReadAt = Date.now();
	let hex = DEFAULT_ACCENT_HEX;
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof parsed?.color === "string" && parsed.color.trim()) hex = parsed.color;
	} catch {
		// Missing, unreadable, or malformed config all fall back to the default.
	}
	const rgb = hexToRgb(hex) ?? hexToRgb(DEFAULT_ACCENT_HEX)!;
	cachedAnsi = `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	return cachedAnsi;
}

/** Colorize text with the configured accent. Used by the editor border and the
 *  plan-progress box so both track the same color. */
export const accentBorder: BorderColor = (text) =>
	`${accentAnsi()}${text}${ANSI_FOREGROUND_RESET}`;

/**
 * Pi rewrites `editor.borderColor` when thinking level, model, or bash mode
 * changes. Replace that mutable field with a fixed accessor so those updates
 * remain harmless while every other editor behavior stays native.
 */
export function lockAccentBorder<T extends EditorLike>(editor: T): T {
	if (editor[ACCENT_BORDER_LOCK]) return editor;

	Object.defineProperty(editor, "borderColor", {
		configurable: true,
		enumerable: true,
		get: () => accentBorder,
		set: () => {
			// Intentionally ignore Pi's thinking-level and bash-mode border updates.
		},
	});
	Object.defineProperty(editor, ACCENT_BORDER_LOCK, {
		configurable: true,
		value: true,
	});
	return editor;
}

export function createAccentEditorFactory(previous?: any) {
	return (tui: any, theme: any, keybindings: any) => {
		const editor = previous
			? previous(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);
		return lockAccentBorder(editor);
	};
}

export default function (pi: ExtensionAPI) {
	let previousFactory: any;
	let installedFactory: any;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		previousFactory = ctx.ui.getEditorComponent();
		installedFactory = createAccentEditorFactory(previousFactory);
		ctx.ui.setEditorComponent(installedFactory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Compose cleanly with history-search and any future editor extension.
		// Only restore our predecessor when this wrapper still owns the editor.
		if (ctx.ui.getEditorComponent() === installedFactory) {
			ctx.ui.setEditorComponent(previousFactory);
		}
		previousFactory = undefined;
		installedFactory = undefined;
	});
}
