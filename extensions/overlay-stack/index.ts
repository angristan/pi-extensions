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

	constructor(private readonly theme: Theme) {}

	setViewport(width: number, height: number) {
		this.terminalWidth = width;
		this.terminalHeight = height;
	}

	preferredWidth(): number {
		const visible = activeCards(this.terminalWidth, this.terminalHeight);
		return Math.max(1, ...visible.map((card) => card.width));
	}

	private selectedCards(maxRows: number): OverlayCardDefinition[] {
		const selected: OverlayCardDefinition[] = [];
		for (const card of activeCards(this.terminalWidth, this.terminalHeight)) {
			const next = [...selected, card];
			const shellRows = next.length * 2 + Math.max(0, next.length - 1); // borders + gaps
			const minimumBodyRows = next.reduce((total, item) => total + minimumBodyHeight(item), 0);
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
		const shellRows = selected.length * 2 + Math.max(0, selected.length - 1);
		let remainingBodyRows = maxRows - shellRows;
		const sections: Array<{ title: string; body: string[] }> = [];

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
			if (index > 0) lines.push(" ".repeat(width));
			lines.push(topBorder(section.title));
			for (const bodyLine of section.body) lines.push(contentLine(bodyLine));
			lines.push(accentBorder(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
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
