import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/**
 * Structural shape of the TUI methods we patch. Declared standalone rather
 * than as `TUI & {…}` because `applyLineResets` is private on `TUI`, so the
 * intersection collapses to `never`. We cast through `unknown` at the call site.
 */
type LineResetsHost = {
	applyLineResets(lines: string[]): string[];
	[PATCH]?: PatchState;
};

const HOST_KEY = "cached-line-resets-host";
const PATCH = Symbol.for("pi.cached-line-resets.patch");
const MAX_CACHE_ENTRIES = 8_192;
const MAX_CACHEABLE_LINE_LENGTH = 16_384;


interface PatchState {
	owner: symbol;
	original: (lines: string[]) => string[];
	cache: Map<string, string>;
	hits: number;
	misses: number;
	bypassed: number;
	clears: number;
}

function installPatch(tui: LineResetsHost): () => void {
	const owner = Symbol("cached-line-resets-owner");
	const existing = tui[PATCH];
	if (existing) {
		existing.owner = owner;
		existing.cache.clear();
		existing.hits = 0;
		existing.misses = 0;
		existing.bypassed = 0;
		existing.clears = 0;
		return () => {
			if (tui[PATCH]?.owner !== owner) return;
			tui.applyLineResets = existing.original;
			delete tui[PATCH];
		};
	}

	const original = tui.applyLineResets;
	const state: PatchState = {
		owner,
		original,
		cache: new Map(),
		hits: 0,
		misses: 0,
		bypassed: 0,
		clears: 0,
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

	return () => {
		if (tui[PATCH]?.owner !== owner) return;
		tui.applyLineResets = original;
		delete tui[PATCH];
	};
}

class CacheHost implements Component {
	private readonly restore: () => void;

	constructor(tui: TUI) {
		this.restore = installPatch(tui as unknown as LineResetsHost);
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
