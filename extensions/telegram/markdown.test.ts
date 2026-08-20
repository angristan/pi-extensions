import { describe, expect, test } from "bun:test";
import { telegramMarkdownToHtml } from "./markdown";

describe("Telegram Markdown formatting", () => {
	test("converts common rich formatting to Telegram HTML", () => {
		const message = [
			"## Crawl complete",
			"",
			"**42 files** are *ready* with ~~no failures~~.",
			"",
			"- [x] Indexed",
			"- [ ] Reviewed",
			"",
			"> Open the [report](https://example.com/report?a=1&b=2).",
			"",
			"```json",
			'{"status":"ok"}',
			"```",
		].join("\n");

		expect(telegramMarkdownToHtml(message)).toBe([
			"<b>Crawl complete</b>",
			"",
			"<b>42 files</b> are <i>ready</i> with <s>no failures</s>.",
			"",
			"• ☑ Indexed",
			"• ☐ Reviewed",
			"",
			'<blockquote>Open the <a href="https://example.com/report?a=1&amp;b=2">report</a>.</blockquote>',
			"",
			'<pre><code class="language-json">{"status":"ok"}</code></pre>',
		].join("\n"));
	});

	test("escapes raw HTML and unsafe links", () => {
		expect(telegramMarkdownToHtml('<b>not markup</b> [run](javascript:alert("x"))'))
			.toBe('&lt;b&gt;not markup&lt;/b&gt; run (javascript:alert("x"))');
	});

	test("preserves plain text and line breaks", () => {
		expect(telegramMarkdownToHtml("First < second\nNext & final"))
			.toBe("First &lt; second\nNext &amp; final");
	});
});
