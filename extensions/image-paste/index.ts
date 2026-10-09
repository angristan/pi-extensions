import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { makeTokensAtomic } from "./atomic.ts";
import { DEFAULT_SETTINGS, hexForeground, MAX_ROWS, MIN_ROWS, parseColor, parseRows, readSettings, thumbnailRows, writeSettings, type PreviewSettings } from "./config.ts";
import { bracketedPasteContent, imageToken, parsePastedImages, PASTE_END, PASTE_START, PI_CLIPBOARD_PATH, referencedLabels } from "./paste.ts";
import { PastedImageStore, type StoredImage } from "./store.ts";
import { ThumbnailStrip, type StripItem } from "./strip.ts";
import { ImageViewer, type ViewerItem } from "./viewer.ts";

export const ENTRY_TYPE = "image-paste";
const WIDGET = "image-paste";
const settingsPath = () => join(getAgentDir(), "image-paste.json");
const USAGE = `Usage: /images [prompt on|off | transcript on|off | rows auto|${MIN_ROWS}-${MAX_ROWS} | color <theme color|#rrggbb> | settings]`;
const SETTING_COMPLETIONS = ["prompt on", "prompt off", "transcript on", "transcript off", "rows auto", "rows 4", "rows 8", "color warning", "color accent", "settings"];

export interface ImagePasteEntry {
	version: 1;
	images: (StoredImage & { label: number })[];
}

interface DraftImage {
	label: number;
	stored?: StoredImage;
	failed?: boolean;
	ready: Promise<StoredImage | undefined>;
}

function entryImages(data: unknown): ImagePasteEntry["images"] | undefined {
	const entry = data as Partial<ImagePasteEntry> | undefined;
	if (entry?.version !== 1 || !Array.isArray(entry.images)) return undefined;
	const images = entry.images.filter((image) => typeof image?.digest === "string" && typeof image.mimeType === "string" && Number.isInteger(image.label));
	return images.length ? images : undefined;
}

export interface ImagePasteOptions {
	store?: PastedImageStore;
}

export default function imagePaste(pi: ExtensionAPI, options: ImagePasteOptions = {}): void {
	const store = options.store ?? new PastedImageStore();
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let draft = new Map<number, DraftImage>();
	let nextLabel = 1;
	let viewerOpen = false;
	let normalizing = false;
	let settings: PreviewSettings = { ...DEFAULT_SETTINGS };

	const requestRender = () => tui?.requestRender();
	const rows = () => thumbnailRows(settings.previewRows, tui?.terminal.rows ?? 24);
	const tokenBehavior = {
		isLive: (label: number) => draft.has(label),
		// OpenCode's pasted-content style: bold, background-colored text on a colored block.
		highlight: (token: string) => {
			const theme = ctx?.ui.theme;
			if (!theme) return token;
			const color = settings.tokenColor;
			let colored: string;
			if (color.startsWith("#")) colored = `${hexForeground(color)}${token}\x1b[39m`;
			else {
				try { colored = theme.fg(color as ThemeColor, token); } catch { colored = theme.fg("warning", token); }
			}
			return theme.bold(theme.inverse(colored));
		},
	};

	const resetDraft = () => {
		draft = new Map();
		nextLabel = 1;
	};

	const addDraft = (path: string): number => {
		const label = nextLabel++;
		const item: DraftImage = { label, ready: Promise.resolve(undefined) };
		item.ready = store.add(path).then(
			(stored) => { item.stored = stored; requestRender(); return stored; },
			() => { item.failed = true; requestRender(); return undefined; },
		);
		draft.set(label, item);
		return label;
	};

	/** Draft images still referenced by the editor text, ordered by label. */
	const referencedDraft = (text: string) => referencedLabels(text)
		.filter((label) => draft.has(label))
		.sort((a, b) => a - b)
		.map((label) => draft.get(label)!);

	const sessionImages = (): ViewerItem[] => {
		const items: ViewerItem[] = [];
		for (const entry of ctx?.sessionManager.getBranch() ?? []) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			for (const image of entryImages(entry.data) ?? []) items.push({ label: image.label, image });
		}
		return items;
	};

	const openViewer = async (select?: (items: ViewerItem[]) => number) => {
		if (!ctx?.hasUI || viewerOpen) return;
		const items = [...sessionImages(), ...referencedDraft(ctx.ui.getEditorText())
			.filter((item) => item.stored)
			.map((item) => ({ label: item.label, image: item.stored! }))];
		if (!items.length) {
			ctx.ui.notify("No pasted images yet. Paste an image path or screenshot into the editor.", "info");
			return;
		}
		const start = Math.max(0, Math.min(items.length - 1, select ? select(items) : items.length - 1));
		viewerOpen = true;
		requestRender();
		try {
			await ctx.ui.custom<void>((viewTui, theme, _keys, done) => new ImageViewer(items, start, store, theme, viewTui, () => done()));
		} finally {
			viewerOpen = false;
			requestRender();
		}
	};

	/** Pi's own Ctrl+V inserts a temporary file path; turn it into a token like pasted paths. */
	const normalizePiClipboardPaths = (text: string) => {
		if (normalizing || !ctx || !PI_CLIPBOARD_PATH.test(text)) return;
		PI_CLIPBOARD_PATH.lastIndex = 0;
		normalizing = true;
		queueMicrotask(() => {
			normalizing = false;
			if (!ctx) return;
			const current = ctx.ui.getEditorText();
			const next = current.replace(PI_CLIPBOARD_PATH, (path) => imageToken(addDraft(path)));
			if (next !== current) ctx.ui.setEditorText(next);
		});
	};

	class DraftWidget implements Component {
		private strip?: ThumbnailStrip;
		private signature = "";

		constructor(private readonly theme: Theme) {}

		render(width: number): string[] {
			if (!ctx || viewerOpen) return [];
			const text = ctx.ui.getEditorText();
			normalizePiClipboardPaths(text);
			if (!text.trim() && draft.size) resetDraft();
			if (!settings.promptPreview) return [];
			const items: StripItem[] = referencedDraft(text).map((item) => ({ label: item.label, image: item.stored, failed: item.failed }));
			const signature = items.map((item) => `${item.label}:${item.image?.digest ?? (item.failed ? "x" : "…")}`).join(",");
			if (signature !== this.signature || !this.strip) {
				this.signature = signature;
				this.strip = new ThumbnailStrip(items, store, this.theme, {
					rows,
					requestRender,
					onOpen: (index) => {
						const digest = items[index]?.image?.digest;
						void openViewer((all) => all.findLastIndex((item) => item.image.digest === digest));
					},
				});
			}
			return this.strip.render(width);
		}

		handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
			return this.strip?.handleMouse(event);
		}

		invalidate(): void {
			this.strip = undefined;
		}
	}

	pi.on("session_start", (_event, context) => {
		ctx = context;
		settings = readSettings(settingsPath());
		resetDraft();
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (!context.hasUI || context.mode !== "tui") return;
		context.ui.setWidget(WIDGET, (widgetTui, theme) => {
			tui = widgetTui;
			return new DraftWidget(theme);
		}, { placement: "aboveEditor" });
		unsubscribeInput = context.ui.onTerminalInput((data) => {
			// Runs before the editor sees the key, so tokens are atomic before the first one is inserted.
			// Pi's TUI class exposes the focused editor, though its TUI interface does not declare it.
			const focused = (tui as { getFocusedComponent?: () => Component | null } | undefined)?.getFocusedComponent?.();
			if (focused && "getCursor" in focused) makeTokensAtomic(focused, tokenBehavior);
			const content = bracketedPasteContent(data);
			if (content === undefined) return undefined;
			// Bash mode keeps literal paths for shell commands.
			if (context.ui.getEditorText().trimStart().startsWith("!")) return undefined;
			const images = parsePastedImages(content, context.cwd);
			if (!images) return undefined;
			const tokens = images.map((image) => imageToken(addDraft(image.path)));
			return { data: `${PASTE_START}${tokens.join(" ")} ${PASTE_END}` };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		ctx = undefined;
		tui = undefined;
		resetDraft();
	});

	// Loads before image-store (directory order), so it can externalize these attachments.
	pi.on("input", async (event, context) => {
		if (!draft.size) return undefined;
		const items = referencedDraft(event.text);
		resetDraft();
		if (!items.length) return undefined;
		const attached: ImageContent[] = [];
		const recorded: ImagePasteEntry["images"] = [];
		for (const item of items) {
			const stored = await item.ready;
			const data = stored && store.load(stored);
			if (!stored || !data) continue;
			attached.push({ type: "image", data: data.toString("base64"), mimeType: stored.mimeType });
			recorded.push({ ...stored, label: item.label });
		}
		const missing = items.length - attached.length;
		if (missing) context.ui.notify(`${missing} pasted image${missing === 1 ? " was" : "s were"} unavailable and not sent.`, "warning");
		if (!attached.length) return undefined;
		pi.appendEntry<ImagePasteEntry>(ENTRY_TYPE, { version: 1, images: recorded });
		return { action: "transform", text: event.text, images: [...(event.images ?? []), ...attached] };
	});

	pi.registerEntryRenderer<ImagePasteEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const images = entryImages(entry.data);
		if (!images || !settings.transcriptPreview) return undefined;
		return new ThumbnailStrip(images.map((image) => ({ label: image.label, image })), store, theme, {
			rows,
			requestRender,
			onOpen: (index) => {
				const target = images[index];
				void openViewer((all) => {
					const offset = findEntryOffset(entry.id);
					return offset >= 0 ? offset + index : all.findIndex((item) => item.image.digest === target?.digest);
				});
			},
		});
	});

	/** Index of an entry's first image within the branch-wide viewer list. */
	const findEntryOffset = (entryId: string): number => {
		let offset = 0;
		for (const entry of ctx?.sessionManager.getBranch() ?? []) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			if (entry.id === entryId) return offset;
			offset += entryImages(entry.data)?.length ?? 0;
		}
		return -1;
	};

	pi.registerMarkdownTransformer((markdown, context) => context.messageType === "user"
		? markdown.replace(/(?<!`)\[Image \d+\](?!`)/g, (token) => `\`${token}\``)
		: markdown);

	const describeSettings = () => {
		const onOff = (value: boolean) => value ? "on" : "off";
		const size = settings.previewRows === "auto" ? `auto (${rows()})` : String(settings.previewRows);
		return `Image previews: prompt ${onOff(settings.promptPreview)} · transcript ${onOff(settings.transcriptPreview)} · rows ${size} · token color ${settings.tokenColor}`;
	};

	const configure = (args: string, context: ExtensionContext) => {
		const [rawKey = "", rawValue, extra] = args.trim().split(/\s+/);
		const key = rawKey.toLowerCase();
		const value = rawValue?.toLowerCase();
		if (key === "settings" && !value) {
			context.ui.notify(describeSettings(), "info");
			return;
		}
		let update: Partial<PreviewSettings> | undefined;
		if (extra === undefined && (value === "on" || value === "off")) {
			if (key === "prompt") update = { promptPreview: value === "on" };
			else if (key === "transcript") update = { transcriptPreview: value === "on" };
		} else if (extra === undefined && key === "rows") {
			const previewRows = parseRows(value);
			if (previewRows !== undefined) update = { previewRows };
		} else if (extra === undefined && key === "color") {
			const tokenColor = parseColor(rawValue);
			if (tokenColor && !tokenColor.startsWith("#")) {
				try { context.ui.theme.fg(tokenColor as ThemeColor, ""); } catch {
					context.ui.notify(`Unknown theme color: ${tokenColor}. Use a Pi theme color such as warning or accent, or #rrggbb.`, "error");
					return;
				}
			}
			if (tokenColor) update = { tokenColor };
		}
		if (!update) {
			context.ui.notify(USAGE, "error");
			return;
		}
		try {
			writeSettings(settingsPath(), update);
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : "Image settings could not be saved.", "error");
			return;
		}
		settings = { ...settings, ...update };
		// Rebuild transcript entries so their previews appear or disappear now.
		tui?.invalidate();
		requestRender();
		context.ui.notify(describeSettings(), "info");
	};

	pi.registerCommand("images", {
		description: "View pasted images, or configure previews: /images [prompt|transcript on|off, rows auto|N, settings]",
		getArgumentCompletions: (prefix) => {
			const matches = SETTING_COMPLETIONS.filter((value) => value.startsWith(prefix.trimStart().toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, context) => {
			if (args.trim()) configure(args, context);
			else await openViewer();
		},
	});

	pi.registerShortcut("alt+i", {
		description: "View pasted images",
		handler: async () => { await openViewer(); },
	});
}
