import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";

const HOST_WIDGET_KEY = "overlay-stack-host";
const OVERLAY_MAX_HEIGHT_RATIO = 0.8;

export interface OverlayCardDefinition {
	id: string;
	order: number;
	width: number;
	minHeight: number;
	minTerminalWidth?: number;
	minTerminalHeight?: number;
	visible: () => boolean;
	render: (width: number, maxHeight: number, theme: Theme) => string[];
}

export interface OverlayCardHandle {
	invalidate(): void;
	unregister(): void;
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

class OverlayStackComponent implements Component {
	private terminalWidth = 0;
	private terminalHeight = 0;

	constructor(private readonly theme: Theme) {}

	setViewport(width: number, height: number) {
		this.terminalWidth = width;
		this.terminalHeight = height;
	}

	preferredWidth(): number {
		const visible = activeCards(this.terminalWidth, this.terminalHeight);
		return Math.max(1, ...visible.map((card) => card.width));
	}

	canRender(): boolean {
		const maxRows = Math.max(1, Math.floor(this.terminalHeight * OVERLAY_MAX_HEIGHT_RATIO));
		return activeCards(this.terminalWidth, this.terminalHeight).some((card) => card.minHeight <= maxRows);
	}

	render(width: number): string[] {
		const maxRows = Math.max(1, Math.floor(this.terminalHeight * OVERLAY_MAX_HEIGHT_RATIO));
		const lines: string[] = [];

		for (const card of activeCards(this.terminalWidth, this.terminalHeight)) {
			const gapRows = lines.length > 0 ? 1 : 0;
			const remaining = maxRows - lines.length - gapRows;
			if (remaining < card.minHeight) continue;

			const cardWidth = Math.max(1, Math.min(width, card.width));
			let rendered: string[];
			try {
				rendered = card.render(cardWidth, remaining, this.theme);
			} catch {
				continue;
			}
			if (rendered.length === 0 || rendered.length > remaining) continue;

			if (gapRows) lines.push(" ".repeat(width));
			const leftPadding = " ".repeat(Math.max(0, width - cardWidth));
			for (const renderedLine of rendered) {
				const clipped = truncateToWidth(renderedLine, cardWidth, "");
				const rightPadding = " ".repeat(Math.max(0, cardWidth - visibleWidth(clipped)));
				lines.push(`${leftPadding}${clipped}${rightPadding}`);
			}
		}

		return lines;
	}

	invalidate(): void {}
}

class OverlayStackHost implements Component {
	private readonly stack: OverlayStackComponent;
	private readonly options: OverlayOptions;
	private readonly handle: OverlayHandle;
	private readonly stopRegistrySubscription: () => void;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		theme: Theme,
		private readonly onDispose: () => void,
	) {
		this.stack = new OverlayStackComponent(theme);
		this.options = {
			nonCapturing: true,
			anchor: "top-right",
			width: 1,
			maxHeight: "80%",
			margin: { top: 1, right: 2 },
			visible: (terminalWidth, terminalHeight) => {
				this.stack.setViewport(terminalWidth, terminalHeight);
				this.options.width = this.stack.preferredWidth();
				return this.stack.canRender();
			},
		};
		this.handle = tui.showOverlay(this.stack, this.options);
		this.stopRegistrySubscription = subscribeToRegistry(() => this.refresh());
	}

	refresh() {
		this.stack.invalidate();
		this.tui.requestRender();
	}

	setModalHidden(hidden: boolean) {
		this.handle.setHidden(hidden);
		this.tui.requestRender();
	}

	render(): string[] {
		return [];
	}

	invalidate() {
		this.stack.invalidate();
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.stopRegistrySubscription();
		this.handle.hide();
		this.onDispose();
	}
}

export default function (pi: ExtensionAPI) {
	let host: OverlayStackHost | undefined;
	const modalOwners = new Set<string>();

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
			nextHost.setModalHidden(modalOwners.size > 0);
			return nextHost;
		});
	};

	const stopModalListener = pi.events.on("modal-overlay", (event: unknown) => {
		if (!event || typeof event !== "object") return;
		const payload = event as { id?: unknown; hidden?: unknown };
		if (typeof payload.id !== "string" || typeof payload.hidden !== "boolean") return;
		if (payload.hidden) modalOwners.add(payload.id);
		else modalOwners.delete(payload.id);
		host?.setModalHidden(modalOwners.size > 0);
	});

	pi.on("session_start", (_event, ctx) => mountHost(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		clearHost(ctx);
		modalOwners.clear();
		stopModalListener();
	});
}
