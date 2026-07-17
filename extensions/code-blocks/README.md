# code-blocks

Renders fenced code blocks as bordered, syntax-highlighted boxes instead of
pi's default plain code.

```
╭ python ───────────────────────────╮
│ def greet(name):                  │
│     return f"hi {name}"           │
╰───────────────────────────────────╯
```

- Language label in the top border (truncated to fit)
- Syntax highlighting via the active theme
- Wrapped to the pane width with `│` borders
- Inside **thinking/reasoning** blocks: code is dimmed and italicized to match
  the surrounding trace, so it reads as part of the reasoning, not as output

Patches `Markdown.prototype.renderToken` (reference-counted, restored cleanly
on session end).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
