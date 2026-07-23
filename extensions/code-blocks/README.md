# code-blocks

Renders fenced code blocks as copy-friendly, syntax-highlighted blocks instead
of pi's default plain code.

```
── python ─────────────
def greet(name):
    return f"hi {name}"
───────────────────────
```

- Dim language label in the top rule (truncated to fit)
- Top and bottom rules shrink to the longest rendered code row, capped by the
  pane width
- No side borders, so terminal selection does not include framing characters
  on every copied line
- Syntax highlighting via the active theme
- Wrapped to the pane width without adding indentation or padding
- Inside **thinking/reasoning** blocks: code is dimmed and italicized to match
  the surrounding trace, so it reads as part of the reasoning, not as output

Patches `Markdown.prototype.renderToken` (reference-counted, restored cleanly
on session end). The exported `renderCodeBox` helper remains bordered for the
`better-native-pi` bash command preview.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
