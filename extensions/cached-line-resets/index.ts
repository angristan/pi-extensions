import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/**
 * Structural shape of the TUI methods we patch. Declared standalone rather
 * than as `TUI & {…}` because the patched methods are private on `TUI`, so the
 * intersection collapses to `never`. We cast through `unknown` at the call site.
 */
type TuiCacheHost = {
	applyLineResets(lines: string[]): string[];
	expandChangedRangeForKittyImages?(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number };
	getKittyImageReservedRows(lines: string[], index: number, maxIndex?: number): number;
	previousLines: string[];
	[PATCH]?: PatchState;
};

const HOST_KEY = "cached-line-resets-host";
const PATCH = Symbol.for("pi.cached-line-resets.patch");
const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_CACHE_ENTRIES = 8_192;
const MAX_CACHEABLE_LINE_LENGTH = 16_384;

type ChangedRange = { firstChanged: number; lastChanged: number };
type ImageBlock = { start: number; end: number };

interface PatchState {
	owner: symbol;
	original: (lines: string[]) => string[];
	originalImageRange?: (firstChanged: number, lastChanged: number, newLines: string[]) => ChangedRange;
	cache: Map<string, string>;
	hits: number;
	misses: number;
	bypassed: number;
	clears: number;
	imagePositionHits: number;
	imagePositionMisses: number;
}

function kittyImageBlocks(tui: TuiCacheHost, lines: string[]): Map<number, ImageBlock> {
	const blocks = new Map<number, ImageBlock>();
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index]?.includes(KITTY_SEQUENCE_PREFIX)) continue;
		const reservedRows = Math.max(1, tui.getKittyImageReservedRows(lines, index));
		const end = Math.min(lines.length - 1, index + reservedRows - 1);
		blocks.set(index, { start: index, end });
		index = end;
	}
	return blocks;
}

function sameImageBlock(
	previous: ImageBlock | undefined,
	next: ImageBlock | undefined,
	previousLines: string[],
	newLines: string[],
): boolean {
	if (!previous || !next || previous.start !== next.start || previous.end !== next.end) return false;
	for (let index = previous.start; index <= previous.end; index += 1) {
		if (previousLines[index] !== newLines[index]) return false;
	}
	return true;
}

function stableKittyImageRange(
	tui: TuiCacheHost,
	state: PatchState,
	firstChanged: number,
	lastChanged: number,
	newLines: string[],
): ChangedRange {
	let expandedFirstChanged = firstChanged;
	let expandedLastChanged = lastChanged;
	const previousBlocks = kittyImageBlocks(tui, tui.previousLines);
	const nextBlocks = kittyImageBlocks(tui, newLines);
	const starts = new Set([...previousBlocks.keys(), ...nextBlocks.keys()]);

	for (const start of starts) {
		const previous = previousBlocks.get(start);
		const next = nextBlocks.get(start);
		const blockStart = Math.min(previous?.start ?? start, next?.start ?? start);
		const blockEnd = Math.max(previous?.end ?? start, next?.end ?? start);
		const overlapsChange = blockStart <= lastChanged && blockEnd >= firstChanged;
		const followsChange = blockStart >= firstChanged;
		if (!overlapsChange && followsChange && sameImageBlock(previous, next, tui.previousLines, newLines)) {
			state.imagePositionHits += 1;
			continue;
		}
		if (!overlapsChange && !followsChange) continue;
		state.imagePositionMisses += 1;
		expandedFirstChanged = Math.min(expandedFirstChanged, blockStart);
		expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
	}
	return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
}

function installPatch(tui: TuiCacheHost): () => void {
	const owner = Symbol("cached-line-resets-owner");
	const existing = tui[PATCH];
	if (existing) {
		existing.owner = owner;
		existing.cache.clear();
		existing.hits = 0;
		existing.misses = 0;
		existing.bypassed = 0;
		existing.clears = 0;
		existing.imagePositionHits = 0;
		existing.imagePositionMisses = 0;
		return () => {
			if (tui[PATCH]?.owner !== owner) return;
			tui.applyLineResets = existing.original;
			if (existing.originalImageRange) tui.expandChangedRangeForKittyImages = existing.originalImageRange;
			delete tui[PATCH];
		};
	}

	const original = tui.applyLineResets;
	const originalImageRange = tui.expandChangedRangeForKittyImages;
	const state: PatchState = {
		owner,
		original,
		originalImageRange,
		cache: new Map(),
		hits: 0,
		misses: 0,
		bypassed: 0,
		clears: 0,
		imagePositionHits: 0,
		imagePositionMisses: 0,
	};
	tui[PATCH] = state;

	tui.applyLineResets = function cachedApplyLineResets(lines: string[]): string[] {
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line.length > MAX_CACHEABLE_LINE_LENGTH) {
				state.bypassed += 1;
				lines[index] = original.call(tui, [line])[0];
				continue;
			}

			const cached = state.cache.get(line);
			if (cached !== undefined) {
				state.hits += 1;
				lines[index] = cached;
				continue;
			}

			state.misses += 1;
			const normalized = original.call(tui, [line])[0];
			state.cache.set(line, normalized);
			lines[index] = normalized;
		}

		// Streaming creates one new line variant per delta. Bound memory without
		// adding LRU bookkeeping to the hot path; static lines repopulate once.
		if (state.cache.size > MAX_CACHE_ENTRIES) {
			state.cache.clear();
			state.clears += 1;
		}
		return lines;
	};

	if (originalImageRange) {
		tui.expandChangedRangeForKittyImages = function cachedKittyImageRange(
			firstChanged: number,
			lastChanged: number,
			newLines: string[],
		): ChangedRange {
			if (firstChanged < 0 || lastChanged < firstChanged) {
				return originalImageRange.call(tui, firstChanged, lastChanged, newLines);
			}
			return stableKittyImageRange(tui, state, firstChanged, lastChanged, newLines);
		};
	}

	return () => {
		if (tui[PATCH]?.owner !== owner) return;
		tui.applyLineResets = original;
		if (originalImageRange) tui.expandChangedRangeForKittyImages = originalImageRange;
		delete tui[PATCH];
	};
}

class CacheHost implements Component {
	private readonly restore: () => void;

	constructor(tui: TUI) {
		this.restore = installPatch(tui as unknown as TuiCacheHost);
	}

	render(): string[] { return []; }
	invalidate(): void {}
	dispose(): void { this.restore(); }
}

export default function (pi: ExtensionAPI) {
	let host: CacheHost | undefined;

	const clear = (ctx: any) => {
		ctx.ui.setWidget(HOST_KEY, undefined);
		host?.dispose();
		host = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		clear(ctx);
		ctx.ui.setWidget(HOST_KEY, (tui: TUI) => {
			host = new CacheHost(tui);
			return host;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") clear(ctx);
	});
}
