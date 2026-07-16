import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

function userText(entry: any): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "user") return;
	const content = entry.message.content;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n")
			: "";
	return text.trim() || undefined;
}

class HistoryEditor extends CustomEditor {
	private searching = false;
	private query = "";
	private original = "";
	private matches: string[] = [];
	private matchIndex = 0;
	// The editor we wrap (e.g. accent-color's border-locking wrapper).
	// When not reverse-searching, delegate input/render to it so its border
	// styling and any other customizations remain in effect.
	private readonly delegate: CustomEditor | undefined;

	constructor(tui: any, theme: any, keybindings: any, private readonly prompts: string[],
		previousFactory?: any) {
		super(tui, theme, keybindings);
		this.delegate = previousFactory
			? (() => {
				try { return previousFactory(tui, theme, keybindings); }
				catch { return undefined; }
			})()
			: undefined;

		// Forward borderColor to the wrapped editor. accent-color locks
		// borderColor via a no-op setter so pi's border updates are ignored;
		// without this proxy, pi would see our plain CustomEditor border and
		// overwrite it with the default on every editor swap.
		if (this.delegate) {
			Object.defineProperty(this, "borderColor", {
				configurable: true,
				enumerable: true,
				get: () => (this.delegate as any).borderColor,
				set: (value: any) => { (this.delegate as any).borderColor = value; },
			});
		}
	}

	private refreshMatches(reset = false) {
		const query = this.query.toLowerCase();
		this.matches = query
			? [...this.prompts].reverse().filter((prompt, index, all) => prompt.toLowerCase().includes(query) && all.indexOf(prompt) === index)
			: [];
		if (reset) this.matchIndex = 0;
		if (this.matches.length) this.setText(this.matches[this.matchIndex % this.matches.length]);
		else this.setText(this.original);
		this.tui.requestRender();
	}
	private beginSearch() {
		this.searching = true;
		this.query = "";
		this.original = this.getText();
		this.matches = [];
		this.matchIndex = 0;
		this.tui.requestRender();
	}
	private cancelSearch() {
		this.searching = false;
		this.setText(this.original);
		this.tui.requestRender();
	}
	private acceptSearch() {
		this.searching = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (!this.searching && matchesKey(data, "ctrl+r")) return this.beginSearch();
		if (!this.searching) return super.handleInput(data);

		if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) return this.cancelSearch();
		if (matchesKey(data, Key.enter)) return this.acceptSearch();
		if (matchesKey(data, "ctrl+r") || matchesKey(data, Key.up)) {
			if (this.matches.length) this.matchIndex = (this.matchIndex + 1) % this.matches.length;
			return this.refreshMatches();
		}
		if (matchesKey(data, "ctrl+s") || matchesKey(data, Key.down)) {
			if (this.matches.length) this.matchIndex = (this.matchIndex - 1 + this.matches.length) % this.matches.length;
			return this.refreshMatches();
		}
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.query = this.query.slice(0, -1);
			return this.refreshMatches(true);
		}
		if (matchesKey(data, "ctrl+u")) {
			this.query = "";
			return this.refreshMatches(true);
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			return this.refreshMatches(true);
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.searching) return lines;
		const status = !this.query ? "" : this.matches.length ? `${this.matchIndex + 1}/${this.matches.length}` : "no match";
		const footer = `reverse-i-search: ${this.query}${status ? `  ${status}` : ""}  Enter accept · Esc cancel`;
		lines.push(truncateToWidth(footer, width, "…"));
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let prompts: string[] = [];
	// Capture the editor factory installed before us (e.g. accent-color's
	// border-locking wrapper) and delegate to it for normal input. This keeps
	// reverse-i-search composable regardless of which extension loads last.
	let previousFactory: any;
	let installedFactory: any;

	pi.on("input", (event) => {
		if (event.source === "interactive" && event.text.trim() && !event.text.startsWith("/")) prompts.push(event.text);
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		prompts = ctx.sessionManager.getBranch().map(userText).filter((text): text is string => Boolean(text));
		previousFactory = ctx.ui.getEditorComponent();
		installedFactory = (tui: any, theme: any, keybindings: any) =>
			new HistoryEditor(tui, theme, keybindings, prompts, previousFactory);
		ctx.ui.setEditorComponent(installedFactory);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Only restore our predecessor when this wrapper still owns the editor.
		if (ctx.ui.getEditorComponent() === installedFactory) {
			ctx.ui.setEditorComponent(previousFactory);
		}
		previousFactory = undefined;
		installedFactory = undefined;
	});
}
