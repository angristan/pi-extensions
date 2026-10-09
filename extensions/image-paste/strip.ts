import { convertToPng, resizeImage, type Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, Image, truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { blit, decodePng, encodePng, type Rgba } from "./png.ts";
import { imageToken } from "./paste.ts";
import type { PastedImageStore, StoredImage } from "./store.ts";

export const STRIP_ROWS = 8;
const GAP = 2;
const PAD = 1;
const MAX_ASPECT = 2;

export interface StripItem {
	label: number;
	/** Undefined while the original is still being copied into the store. */
	image?: StoredImage;
	failed?: boolean;
}

export interface Slot {
	index: number;
	start: number;
	columns: number;
	thumbColumns: number;
}

/** Bounded insertion-order cache. */
class Lru<K, V> {
	private readonly map = new Map<K, V>();
	constructor(private readonly limit: number) {}
	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value !== undefined) { this.map.delete(key); this.map.set(key, value); }
		return value;
	}
	set(key: K, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
	}
}

type Thumbnail = Rgba | null | Promise<void>;
const thumbnails = new Lru<string, Thumbnail>(64);
const composites = new Lru<string, { image: Image; slots: Slot[]; hidden: number; columns: number }>(24);

/** Decode a stored image resized to fit a pixel box. */
export async function loadResizedPng(store: PastedImageStore, image: StoredImage, maxWidth: number, maxHeight: number): Promise<{ data: string; width: number; height: number } | undefined> {
	const bytes = store.load(image);
	if (!bytes) return undefined;
	const resized = await resizeImage(new Uint8Array(bytes), image.mimeType, { maxWidth: Math.max(1, Math.round(maxWidth)), maxHeight: Math.max(1, Math.round(maxHeight)) });
	if (!resized) return undefined;
	const png = resized.mimeType === "image/png" ? resized.data : (await convertToPng(resized.data, resized.mimeType))?.data;
	return png ? { data: png, width: resized.width, height: resized.height } : undefined;
}

function thumbnailKey(image: StoredImage, boxWidth: number, boxHeight: number) {
	return `${image.digest}:${boxWidth}x${boxHeight}`;
}

/** Arrange thumbnails left to right, leaving room for a `+N` overflow count. */
export function layoutSlots(thumbColumns: number[], available: number): { slots: Slot[]; hidden: number; columns: number } {
	const slots: Slot[] = [];
	let cursor = 0;
	for (let index = 0; index < thumbColumns.length; index++) {
		const columns = thumbColumns[index]!;
		const start = slots.length ? cursor + GAP : 0;
		const remaining = thumbColumns.length - index - 1;
		const reserve = remaining > 0 ? GAP + `+${remaining}`.length : 0;
		if (start + columns + reserve > available && slots.length) break;
		if (start + columns > available) break;
		slots.push({ index, start, columns, thumbColumns: thumbColumns[index]! });
		cursor = start + columns;
	}
	return { slots, hidden: thumbColumns.length - slots.length, columns: cursor };
}

export interface StripOptions {
	/** Thumbnail height in terminal rows, read on every render. */
	rows?: () => number;
	requestRender: () => void;
	onOpen?: (index: number) => void;
}

/**
 * One row of image thumbnails composited into a single terminal image. Like
 * OpenCode, thumbnails carry no captions: the `[Image N]` tokens already name
 * them, in the same order.
 */
export class ThumbnailStrip implements Component {
	private lastSlots: Slot[] = [];
	private lastHidden = 0;

	constructor(private readonly items: StripItem[], private readonly store: PastedImageStore,
		private readonly theme: Theme, private readonly options: StripOptions) {}

	private label(label: number): string {
		return this.theme.bold(this.theme.fg("accent", imageToken(label)));
	}

	private chips(width: number, note?: string): string[] {
		const parts = this.items.map((item) => item.failed ? this.theme.fg("error", `${imageToken(item.label)} unavailable`) : this.label(item.label));
		if (note) parts.push(this.theme.fg("dim", note));
		return [truncateToWidth(" ".repeat(PAD) + parts.join("  "), width)];
	}

	render(width: number): string[] {
		this.lastSlots = [];
		if (!this.items.length || width < 8) return [];
		if (!getCapabilities().images) return this.chips(width, "· terminal images off (set terminal.images)");
		const rows = this.options.rows?.() ?? STRIP_ROWS;
		const cell = getCellDimensions();
		const boxHeight = rows * cell.heightPx;
		const boxWidth = boxHeight * MAX_ASPECT;
		const ready: { item: StripItem; thumb: Rgba }[] = [];
		let pending = false;
		for (const item of this.items) {
			if (item.failed) continue;
			if (!item.image) { pending = true; continue; }
			const key = thumbnailKey(item.image, boxWidth, boxHeight);
			const cached = thumbnails.get(key);
			if (cached === undefined) {
				pending = true;
				const image = item.image;
				thumbnails.set(key, loadResizedPng(this.store, image, boxWidth, boxHeight)
					.then((png) => thumbnails.set(key, png ? decodePng(Buffer.from(png.data, "base64")) : null))
					.catch(() => thumbnails.set(key, null))
					.finally(() => this.options.requestRender()));
			} else if (cached instanceof Promise) pending = true;
			else if (cached) ready.push({ item, thumb: cached });
		}
		if (pending) return this.chips(width, "loading…");
		if (!ready.length) return this.chips(width);

		const available = Math.max(1, width - PAD - 2);
		const thumbColumns = ready.map(({ thumb }) => Math.max(1, Math.ceil(thumb.width / cell.widthPx)));
		const compositeKey = [width, rows, cell.widthPx, cell.heightPx, ...ready.map(({ item }) => `${item.label}:${item.image!.digest}`)].join("|");
		let composite = composites.get(compositeKey);
		if (!composite) {
			const layout = layoutSlots(thumbColumns, available);
			if (!layout.slots.length) return this.chips(width);
			const canvas: Rgba = { width: layout.columns * cell.widthPx, height: boxHeight, data: new Uint8Array(layout.columns * cell.widthPx * boxHeight * 4) };
			for (const slot of layout.slots) blit(canvas, ready[slot.index]!.thumb, slot.start * cell.widthPx, 0);
			const image = new Image(encodePng(canvas).toString("base64"), "image/png", { fallbackColor: (text) => this.theme.fg("muted", text) },
				{ maxWidthCells: layout.columns, maxHeightCells: rows }, { widthPx: canvas.width, heightPx: canvas.height });
			composite = { image, ...layout };
			composites.set(compositeKey, composite);
		}
		this.lastSlots = composite.slots.map((slot) => ({ ...slot, index: this.items.indexOf(ready[slot.index]!.item) }));
		this.lastHidden = composite.hidden;

		const imageLines = composite.image.render(width).map((line) => line ? " ".repeat(PAD) + line : line);
		if (!composite.hidden) return imageLines;
		return [...imageLines, truncateToWidth(" ".repeat(PAD) + this.theme.fg("dim", `+${composite.hidden} more · Alt+I to view all`), width)];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || !this.options.onOpen) return undefined;
		const column = event.x - PAD;
		const slot = this.lastSlots.find((candidate) => column >= candidate.start && column < candidate.start + candidate.columns);
		if (!slot) return undefined;
		this.options.onOpen(slot.index);
		return { handled: true };
	}

	invalidate(): void {}

	/** For tests: slots from the last render. */
	get renderedSlots(): readonly Slot[] { return this.lastSlots; }
	get hiddenCount(): number { return this.lastHidden; }
}
