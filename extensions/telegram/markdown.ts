import { Marked, type Tokens } from "marked";

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}

function safeLink(href: string): string | undefined {
	try {
		const url = new URL(href);
		return ["http:", "https:", "mailto:", "tg:"].includes(url.protocol) ? href : undefined;
	} catch {
		return undefined;
	}
}

const markdown = new Marked();
markdown.setOptions({ gfm: true, breaks: true });
markdown.use({
	renderer: {
		space() {
			return "";
		},
		code({ text, lang }) {
			const language = lang?.trim().split(/\s+/, 1)[0]?.replace(/[^a-zA-Z0-9_+-]/g, "");
			const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
			return `<pre><code${className}>${escapeHtml(text)}</code></pre>\n\n`;
		},
		blockquote({ tokens }) {
			return `<blockquote>${this.parser.parse(tokens).trim()}</blockquote>\n\n`;
		},
		html({ text }) {
			// Raw HTML must remain visible text instead of becoming untrusted Telegram markup.
			return escapeHtml(text);
		},
		def() {
			return "";
		},
		heading({ tokens }) {
			return `<b>${this.parser.parseInline(tokens)}</b>\n\n`;
		},
		hr() {
			return "────────\n\n";
		},
		list(token) {
			const start = typeof token.start === "number" ? token.start : 1;
			const items = token.items.map((item, index) => {
				const marker = token.ordered ? `${start + index}.` : "•";
				const content = this.parser.parse(item.tokens).trim().replace(/\n/g, "\n  ");
				return `${marker} ${content}`;
			});
			return `${items.join("\n")}\n\n`;
		},
		listitem(item) {
			return this.parser.parse(item.tokens);
		},
		checkbox({ checked }) {
			return checked ? "☑ " : "☐ ";
		},
		paragraph({ tokens }) {
			return `${this.parser.parseInline(tokens)}\n\n`;
		},
		table(token) {
			const rows = [token.header, ...token.rows];
			return `${rows.map((row) => row.map((cell) => this.parser.parseInline(cell.tokens)).join(" │ ")).join("\n")}\n\n`;
		},
		tablerow({ text }) {
			return `${text}\n`;
		},
		tablecell({ tokens }) {
			return this.parser.parseInline(tokens);
		},
		strong({ tokens }) {
			return `<b>${this.parser.parseInline(tokens)}</b>`;
		},
		em({ tokens }) {
			return `<i>${this.parser.parseInline(tokens)}</i>`;
		},
		codespan({ text }) {
			return `<code>${escapeHtml(text)}</code>`;
		},
		br() {
			return "\n";
		},
		del({ tokens }) {
			return `<s>${this.parser.parseInline(tokens)}</s>`;
		},
		link({ href, tokens }) {
			const label = this.parser.parseInline(tokens);
			const safeHref = safeLink(href);
			return safeHref ? `<a href="${escapeAttribute(safeHref)}">${label}</a>` : `${label} (${escapeHtml(href)})`;
		},
		image({ href, text }) {
			const label = escapeHtml(text || "Image");
			const safeHref = safeLink(href);
			return safeHref ? `<a href="${escapeAttribute(safeHref)}">🖼 ${label}</a>` : `🖼 ${label}`;
		},
		text(token: Tokens.Text | Tokens.Escape) {
			return token.tokens ? this.parser.parseInline(token.tokens) : escapeHtml(token.text);
		},
	},
});

/** Convert common Markdown into the HTML subset accepted by Telegram messages. */
export function telegramMarkdownToHtml(value: string): string {
	return markdown.parse(value, { async: false }).trimEnd();
}
