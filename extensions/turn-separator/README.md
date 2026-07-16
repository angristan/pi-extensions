# turn-separator

Draws a full-width horizontal `─` rule between turns, so each exchange is
visually separated in the transcript.

After each agent run settles, appends a custom (non-LLM) entry whose renderer
returns pi's native `DynamicBorder` — the same full-width rule used for dialog
borders. Colored via the theme's `mdHr` token, so it matches markdown
horizontal rules and respects the active theme.

```
user: run the tests
assistant: …

────────────────────────────────────────────────────────────────────────────

user: also lint
assistant: …
```

No config, no toggle — always on. On startup (first turn) no rule is drawn.
