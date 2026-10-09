import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, Image, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { imageToken } from "./paste.ts";
import type { PastedImageStore, StoredImage } from "./store.ts";
import { loadResizedPng } from "./strip.ts";

export interface ViewerItem {
	label: number;
	image: StoredImage;
}

type Prepared = { data: string; width: number; height: number } | null;

/** Full-screen pasted-image viewer: one image fitted to the terminal, with previous/next navigation. */
export class ImageViewer implements Component {
	private readonly prepared = new Map<string, Prepared | Promise<void>>();
	private readonly images = new Map<string, Image>();
	private footerRow = -1;

	constructor(private readonly items: ViewerItem[], private index: number, private readonly store: PastedImageStore,
		private readonly theme: Theme, private readonly tui: TUI, private readonly done: () => void) {
		this.index = Math.max(0, Math.min(items.length - 1, index));
	}

	get current(): number { return this.index; }

	private go(delta: number): void {
		const next = Math.max(0, Math.min(this.items.length - 1, this.index + delta));
		if (next === this.index) return;
		this.index = next;
		this.tui.requestRender();
	}

	private row(left: string, middle: string, right: string, width: number): string {
		const inner = Math.max(0, width - 2);
		const middleStart = Math.max(visibleWidth(left) + 1, Math.floor((inner - visibleWidth(middle)) / 2));
		let line = left + " ".repeat(Math.max(0, middleStart - visibleWidth(left))) + middle;
		line += " ".repeat(Math.max(1, inner - visibleWidth(line) - visibleWidth(right))) + right;
		return truncateToWidth(` ${line}`, width);
	}

	private imageLines(item: ViewerItem, width: number, rows: number): string[] {
		const cell = getCellDimensions();
		const maxColumns = Math.max(1, width - 4);
		const key = `${item.image.digest}:${maxColumns}x${rows}:${cell.widthPx}x${cell.heightPx}`;
		const prepared = this.prepared.get(key);
		const centered = (text: string) => [truncateToWidth(" ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text, width)];
		if (prepared === undefined) {
			this.prepared.set(key, loadResizedPng(this.store, item.image, maxColumns * cell.widthPx, rows * cell.heightPx)
				.then((png) => { this.prepared.set(key, png ?? null); })
				.catch(() => { this.prepared.set(key, null); })
				.finally(() => this.tui.requestRender()));
			return centered(this.theme.fg("dim", "loading…"));
		}
		if (prepared instanceof Promise) return centered(this.theme.fg("dim", "loading…"));
		if (!prepared) return centered(this.theme.fg("error", "This image is no longer available."));
		let image = this.images.get(key);
		if (!image) {
			image = new Image(prepared.data, "image/png", { fallbackColor: (text) => this.theme.fg("muted", text) },
				{ maxWidthCells: maxColumns, maxHeightCells: rows, filename: imageToken(item.label) }, { widthPx: prepared.width, heightPx: prepared.height });
			this.images.set(key, image);
		}
		const lines = image.render(width);
		if (!getCapabilities().images) return lines;
		// Pi scales the image to fill the box, magnifying small images.
		const scale = Math.min((maxColumns * cell.widthPx) / prepared.width, (rows * cell.heightPx) / prepared.height);
		const columns = Math.min(maxColumns, Math.ceil((prepared.width * scale) / cell.widthPx));
		const pad = " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
		return lines.map((line) => pad + line);
	}

	render(width: number): string[] {
		const item = this.items[this.index];
		if (!item || width < 10) return [];
		// Leave room for Pi's footer and other widgets so the image is never cropped.
		const total = Math.max(8, this.tui.terminal.rows - 8);
		const imageRows = total - 4;
		const title = this.theme.bold(this.theme.fg("accent", `Image ${this.index + 1} of ${this.items.length}`));
		const header = this.row(title, "", this.theme.fg("dim", "esc"), width);
		let body = this.imageLines(item, width, imageRows);
		const top = Math.max(0, Math.floor((imageRows - body.length) / 2));
		body = [...Array<string>(top).fill(""), ...body];
		while (body.length < imageRows) body.push("");
		const previous = this.theme.fg(this.index > 0 ? "text" : "dim", "← previous");
		const next = this.theme.fg(this.index < this.items.length - 1 ? "text" : "dim", "next →");
		const footer = this.row(previous, this.theme.fg("muted", imageToken(item.label)), next, width);
		this.footerRow = 1 + 1 + imageRows + 1;
		return [header, "", ...body, "", footer];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "left") || data === "h" || data === "p") this.go(-1);
		else if (matchesKey(data, "right") || data === "l" || data === "n") this.go(1);
		else if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) this.done();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y === this.footerRow) {
			if (event.x < event.width / 3) this.go(-1);
			else if (event.x > (event.width * 2) / 3) this.go(1);
			return { handled: true };
		}
		if (event.y === 0 && event.x >= event.width - 5) {
			this.done();
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {
		for (const image of this.images.values()) image.invalidate();
	}
}
