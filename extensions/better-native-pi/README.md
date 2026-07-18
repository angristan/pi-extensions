# better-native-pi

Restyles pi's native tools into compact, reason-first transcript blocks and
groups consecutive read/list/search calls into a single "exploring" block.

```text
• Edited put reasoning on line 1, detail on line 2
  └ index.ts · (+28 -14)
• Ran run the typecheck in 1s ✓
  ╭ bash ───────────────────────────╮
  │ bun test                        │
  ╰─────────────────────────────────╯
  │ 12 pass
```

**Line 1** — status bullet (🟢✓ / 🔴✗ / 🟣running) + semantic verb + the model's
*reasoning* for the call
**Line 2** — non-bash tools use a `└` branch with their target and result summary;
bash uses the custom Markdown-style bordered command box followed by bounded `│`
output

## What it patches

Re-registers pi's built-in tools under their native names (`read`, `write`,
`edit`, `grep`, `find`, `ls`, `bash`) with:
- `renderShell: "self"` — bypasses pi's default card (incl. the baked-in blank
  line per tool), draws a tight block inline
- a **required `reasoning` parameter** injected into each tool's schema; the
  model states the intent of the call, which renders as the line-1 headline.
  The schema requests a present-tense phrase of at most eight words with no
  period and stays compact because it is repeated across all seven schemas
- `execute` delegates to the real built-in tool (reasoning stripped first); when
  `background-jobs` is loaded, `bash` instead uses its managed terminal service
  so quick commands, yielded processes, and `tty: true` prompts share one tool

Successful `edit`/`write` calls append a syntax-highlighted, line-numbered
diff inline. Bash commands reuse the bordered box from the `code-blocks`
Markdown renderer with the dedicated shell tokenizer for syntax highlighting.
Long commands wrap at top-level shell operators and quote-aware word boundaries;
the box spans the full available transcript width.
`Ctrl+O` (`app.tools.expand`) reveals full commands, raw output, or full written
content without duplicating an already-shown diff. Read results backed by
`image-store` render their live sidecar inline in the same tool row after the
agent settles; resumed images stay unloaded until expanded.

Exploration groups wait until a tool actually starts executing before rendering
live rows. This avoids flashing streamed JSON fragments such as half-written
paths and prevents provisional provider tool-call updates from appearing as
brief duplicate `Exploring` blocks.

## Layout

```
better-native-pi/
├── index.ts       composer: fileTools(pi) + bash(pi) + exploration(pi)
├── render.ts      palette + shortPath
├── shell.ts       bash/sh syntax tokenizer
├── diff.ts        diff palette + colorizeDiff + WidthAwareLines (+stats)
├── core.ts        block builder + summarize + reasoning (re-exports)
├── file-tools.ts  read/write/edit/grep/find/ls restylers
├── bash.ts        bash restyler + bounded output (+stats)
└── exploration.ts groups consecutive read/list/search calls
```

## Observability

Render-cache stats publish to `Symbol.for("pi.renderer-cache.stats")` under
`better-native-pi` and `better-native-pi:bash`; `/doctor` reports hit-rate and
volatile-render churn for both.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`background-jobs`](../background-jobs/), [`code-blocks`](../code-blocks/), [`hyperlinks`](../hyperlinks/), [`image-store`](../image-store/).
- **Used by extensions:** [`background-jobs`](../background-jobs/), [`web-search`](../web-search/).
