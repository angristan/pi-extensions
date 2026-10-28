import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { accentBorder } from "../accent-color/index.js";

const HOST_WIDGET_KEY = "overlay-stack-host";
const OVERLAY_MAX_HEIGHT_RATIO = 0.8;

/**
 * User-selected stack display. `compact` keeps one title-only card per section;
 * card titles already carry each section's summary, so bodies can be dropped.
 */
export type OverlayDisplayMode = "shown" | "compact" | "hidden";
const DISPLAY_MODE_CYCLE: readonly OverlayDisplayMode[] = ["shown", "compact", "hidden"];

function nextDisplayMode(mode: OverlayDisplayMode): OverlayDisplayMode {
	return DISPLAY_MODE_CYCLE[(DISPLAY_MODE_CYCLE.indexOf(mode) + 1) % DISPLAY_MODE_CYCLE.length]!;
}

export interface OverlayCardDefinition {
	id: string;
	order: number;
	width: number;
	minBodyHeight: number;
	requiredBodyHeight?: () => number;
	minTerminalWidth?: number;
	minTerminalHeight?: number;
	visible: () => boolean;
	title: (theme: Theme) => string;
	renderBody: (width: number, maxHeight: number, theme: Theme) => string[];
}

export interface OverlayCardHandle {
	invalidate(): void;
	unregister(): void;
}

interface OverlaySection {
	title: string;
	body: string[];
}

interface RegisteredCard {
	token: symbol;
	definition: OverlayCardDefinition;
}

interface OverlayRegistry {
	cards: Map<string, RegisteredCard>;
	listeners: Set<() => void>;
}

// Pi can evaluate an extension entry point and a sibling's relative import as
// separate Jiti module instances. Keep the registry process-global so the host
// and cards still meet at one shared boundary without sharing feature state.
const REGISTRY_KEY = Symbol.for("pi-extensions.overlay-stack.registry.v1");
const registry = ((globalThis as any)[REGISTRY_KEY] ??= {
	cards: new Map<string, RegisteredCard>(),
	listeners: new Set<() => void>(),
}) as OverlayRegistry;
const cards = registry.cards;
const registryListeners = registry.listeners;

function notifyRegistryListeners() {
	for (const listener of registryListeners) listener();
}

function subscribeToRegistry(listener: () => void): () => void {
	registryListeners.add(listener);
	return () => registryListeners.delete(listener);
}

/** Register one independently owned card with the shared top-right overlay. */
export function registerOverlayCard(definition: OverlayCardDefinition): OverlayCardHandle {
	const token = Symbol(definition.id);
	cards.set(definition.id, { token, definition });
	notifyRegistryListeners();
	return {
		invalidate: notifyRegistryListeners,
		unregister() {
			if (cards.get(definition.id)?.token !== token) return;
			cards.delete(definition.id);
			notifyRegistryListeners();
		},
	};
}

function cardIsVisible(card: OverlayCardDefinition, terminalWidth: number, terminalHeight: number): boolean {
	if (terminalWidth < (card.minTerminalWidth ?? 1)) return false;
	if (terminalHeight < (card.minTerminalHeight ?? 1)) return false;
	try {
		return card.visible();
	} catch {
		return false;
	}
}

function activeCards(terminalWidth: number, terminalHeight: number): OverlayCardDefinition[] {
	return [...cards.values()]
		.map((entry) => entry.definition)
		.filter((card) => cardIsVisible(card, terminalWidth, terminalHeight))
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function cardTitle(card: OverlayCardDefinition, theme: Theme): string | undefined {
	try {
		return card.title(theme);
	} catch {
		return undefined;
	}
}

function minimumBodyHeight(card: OverlayCardDefinition): number {
	try {
		return Math.max(card.minBodyHeight, card.requiredBodyHeight?.() ?? 0);
	} catch {
		return card.minBodyHeight;
	}
}

class OverlayStackComponent implements Component {
	private terminalWidth = 0;
	private terminalHeight = 0;
	private compact = false;

	constructor(private readonly theme: Theme) {}

	setViewport(width: number, height: number) {
		this.terminalWidth = width;
		this.terminalHeight = height;
	}

	setCompact(compact: boolean) {
		this.compact = compact;
	}

	preferredWidth(): number {
		const visible = activeCards(this.terminalWidth, this.terminalHeight);
		if (!this.compact) return Math.max(1, ...visible.map((card) => card.width));
		// Title-only cards shrink to the widest title plus its corner glyphs, but
		// never grow past the width the card asked for in the full layout.
		return Math.max(1, ...visible.map((card) => {
			const title = cardTitle(card, this.theme);
			return title === undefined ? 1 : Math.min(card.width, visibleWidth(title) + 2);
		}));
	}

	private selectedCards(maxRows: number): OverlayCardDefinition[] {
		const selected: OverlayCardDefinition[] = [];
		for (const card of activeCards(this.terminalWidth, this.terminalHeight)) {
			const next = [...selected, card];
			// Full cards need borders, bodies, and a blank gap between cards.
			// Compact cards are just a top and bottom border, stacked without gaps.
			const gapRows = this.compact ? 0 : Math.max(0, next.length - 1);
			const shellRows = next.length * 2 + gapRows;
			const minimumBodyRows = this.compact
				? 0
				: next.reduce((total, item) => total + minimumBodyHeight(item), 0);
			if (shellRows + minimumBodyRows <= maxRows) selected.push(card);
		}
		return selected;
	}

	canRender(): boolean {
		const maxRows = Math.max(1, Math.floor(this.terminalHeight * OVERLAY_MAX_HEIGHT_RATIO));
		return this.selectedCards(maxRows).length > 0;
	}

	render(width: number): string[] {
		const maxRows = Math.max(1, Math.floor(this.terminalHeight * OVERLAY_MAX_HEIGHT_RATIO));
		const selected = this.selectedCards(maxRows);
		if (selected.length === 0) return [];

		const contentWidth = Math.max(1, width - 4);
		const sections = this.compact
			? this.compactSections(selected)
			: this.fullSections(selected, maxRows, contentWidth);
		if (sections.length === 0) return [];

		const topBorder = (rawTitle: string) => {
			const title = truncateToWidth(rawTitle, Math.max(1, width - 2), "…");
			const ruleWidth = Math.max(0, width - visibleWidth(title) - 2);
			return `${accentBorder("╭")}${title}${accentBorder("─".repeat(ruleWidth))}${accentBorder("╮")}`;
		};
		const contentLine = (content: string) => {
			const fitted = truncateToWidth(content, contentWidth, "…");
			const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
			return `${accentBorder("│ ")}${fitted}${padding}${accentBorder(" │")}`;
		};

		const lines: string[] = [];
		for (let index = 0; index < sections.length; index++) {
			const section = sections[index]!;
			if (index > 0 && !this.compact) lines.push(" ".repeat(width));
			lines.push(topBorder(section.title));
			for (const bodyLine of section.body) lines.push(contentLine(bodyLine));
			lines.push(accentBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		}
		return lines;
	}

	private compactSections(selected: OverlayCardDefinition[]): OverlaySection[] {
		const sections: OverlaySection[] = [];
		for (const card of selected) {
			const title = cardTitle(card, this.theme);
			if (title !== undefined) sections.push({ title, body: [] });
		}
		return sections;
	}

	private fullSections(selected: OverlayCardDefinition[], maxRows: number, contentWidth: number): OverlaySection[] {
		const sections: OverlaySection[] = [];
		const shellRows = selected.length * 2 + Math.max(0, selected.length - 1);
		let remainingBodyRows = maxRows - shellRows;
		for (let index = 0; index < selected.length; index++) {
			const card = selected[index]!;
			const reservedForLater = selected
				.slice(index + 1)
				.reduce((total, item) => total + minimumBodyHeight(item), 0);
			const available = remainingBodyRows - reservedForLater;
			let title: string;
			let body: string[];
			try {
				title = card.title(this.theme);
				body = card.renderBody(contentWidth, available, this.theme);
			} catch {
				continue;
			}
			body = body.slice(0, Math.max(0, available));
			if (body.length < card.minBodyHeight) {
				body = Array.from({ length: card.minBodyHeight }, (_, row) => body[row] ?? "");
			}
			sections.push({ title, body });
			remainingBodyRows -= body.length;
		}
		return sections;
	}

	invalidate(): void {}
}

class OverlayStackHost implements Component {
	private current?: {
		stack: OverlayStackComponent;
		handle: OverlayHandle;
	};
	private readonly stopRegistrySubscription: () => void;
	private disposed = false;
	private mode: OverlayDisplayMode = "shown";

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly onDispose: () => void,
	) {
		this.stopRegistrySubscription = subscribeToRegistry(() => this.refresh());
		this.reconcileOverlay();
	}

	refresh() {
		this.current?.stack.invalidate();
		this.reconcileOverlay();
		this.tui.requestRender();
	}

	setMode(mode: OverlayDisplayMode) {
		this.mode = mode;
		this.reconcileOverlay();
		this.tui.requestRender();
	}

	render(): string[] {
		// The stable TUI reference follows Pi when it replaces the renderer.
		// Reconcile on every host render so a removed overlay is recreated on
		// the active renderer, never retained as a hidden entry on the old one.
		this.reconcileOverlay();
		return [];
	}

	invalidate() {
		this.current?.stack.invalidate();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.stopRegistrySubscription();
		this.removeOverlay();
		this.onDispose();
	}

	private reconcileOverlay(): void {
		if (this.disposed) return;

		const terminalWidth = this.tui.terminal.columns;
		const terminalHeight = this.tui.terminal.rows;
		const stack = this.current?.stack ?? new OverlayStackComponent(this.theme);
		stack.setViewport(terminalWidth, terminalHeight);
		// Switching between shown and compact keeps the overlay entry; the
		// visible() callback picks up the new width on the next render.
		stack.setCompact(this.mode === "compact");
		if (this.mode === "hidden" || !stack.canRender()) {
			this.removeOverlay();
			return;
		}
		if (this.current) return;

		// hide() permanently removes an overlay. Always pair a new handle with
		// a fresh component, as required by the TUI overlay lifecycle.
		const options: OverlayOptions = {
			nonCapturing: true,
			anchor: "top-right",
			width: stack.preferredWidth(),
			maxHeight: "80%",
			margin: { top: 1, right: 2 },
			visible: (width, height) => {
				stack.setViewport(width, height);
				options.width = stack.preferredWidth();
				return stack.canRender();
			},
		};
		this.current = { stack, handle: this.tui.showOverlay(stack, options) };
	}

	private removeOverlay(): void {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		current.handle.hide();
	}
}

export default function (pi: ExtensionAPI) {
	let host: OverlayStackHost | undefined;
	let userMode: OverlayDisplayMode = "shown";
	const modalOwners = new Set<string>();

	// An open modal hides the stack without changing the user's choice, so
	// closing the modal restores whichever mode was selected before.
	const syncVisibility = () => host?.setMode(modalOwners.size > 0 ? "hidden" : userMode);
	const cycleDisplayMode = (ctx: any) => {
		userMode = nextDisplayMode(userMode);
		syncVisibility();
		ctx.ui.notify(`Overlay ${userMode}`, "info");
	};
	const clearHost = (ctx: any) => {
		ctx.ui.setWidget(HOST_WIDGET_KEY, undefined);
		host = undefined;
	};
	const mountHost = (ctx: any) => {
		if (ctx.mode !== "tui") return;
		clearHost(ctx);
		ctx.ui.setWidget(HOST_WIDGET_KEY, (tui: TUI, theme: Theme) => {
			let nextHost: OverlayStackHost;
			nextHost = new OverlayStackHost(tui, theme, () => {
				if (host === nextHost) host = undefined;
			});
			host = nextHost;
			syncVisibility();
			return nextHost;
		});
	};

	const stopModalListener = pi.events.on("modal-overlay", (event: unknown) => {
		if (!event || typeof event !== "object") return;
		const payload = event as { id?: unknown; hidden?: unknown };
		if (typeof payload.id !== "string" || typeof payload.hidden !== "boolean") return;
		if (payload.hidden) modalOwners.add(payload.id);
		else modalOwners.delete(payload.id);
		syncVisibility();
	});

	pi.registerCommand("overlay", {
		description: "Cycle the top-right overlay stack: shown, compact, hidden",
		handler: (_args, ctx) => cycleDisplayMode(ctx),
	});
	pi.registerShortcut("ctrl+shift+o", {
		description: "Cycle the top-right overlay stack: shown, compact, hidden",
		handler: cycleDisplayMode,
	});

	pi.on("session_start", (_event, ctx) => mountHost(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		clearHost(ctx);
		modalOwners.clear();
		stopModalListener();
	});
}
