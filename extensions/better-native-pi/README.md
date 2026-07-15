# better-native-pi

Restyles pi's native tools into compact, reason-first 2-line transcript blocks,
and groups consecutive read/list/search calls into a single "exploring" block.

```
• Edited put reasoning on line 1, detail on line 2
  └ index.ts · (+28 -14)
• Ran run the typecheck
  └ bun test · done in 1s
```

**Line 1** — status bullet (🟢✓ / 🔴✗ / 🟣running) + semantic verb + the model's
*reasoning* for the call
**Line 2** — `└` branch + target (path/command/pattern) + colored result summary

## What it patches

Re-registers pi's built-in tools under their native names (`read`, `write`,
`edit`, `grep`, `find`, `ls`, `bash`) with:
- `renderShell: "self"` — bypasses pi's default card (incl. the baked-in blank
  line per tool), draws a tight block inline
- a **required `reasoning` parameter** injected into each tool's schema; the
  model must state the GOAL of the call, which renders as the line-1 headline
- `execute` delegates to the real built-in tool (reasoning stripped first)

Successful `edit`/`write` calls append a syntax-highlighted, line-numbered
diff inline; `Ctrl+O` (`app.tools.expand`) reveals raw output or full written
content without duplicating an already-shown diff.

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
