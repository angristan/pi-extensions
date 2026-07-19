# petit-chat-input-bar

A tiny animated companion sprite that sits above the editor (a la Vibe's petit
chat). It is purely cosmetic and uses smart animation by default.

The pet is anchored just above the input bar's top border so its feet share the
border row:

```
⠦ Working...                                                                    ⡠⣒⠄  ⡔⢄⠔⡄
                                                                               ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣
─────────────────────────────────────────────────────────────────────────────────⠉⠒⠣⠤⠵⠤⠬⠮⠆──

────────────────────────────────────────────────────────────────────────────────────────────
Petit Chat World Domination │ ctx 21%/262K │ ↓ 314K cached 2.35M hit 88% │ ↑ 31K │ $0.70
```

## Animation modes

```text
/petit-chat              Show the current mode
/petit-chat smart        Move occasionally and react more often while Pi works (default)
/petit-chat working      Animate continuously only while Pi works
/petit-chat always       Animate continuously
/petit-chat static       Stay in the neutral pose
```

Animated modes call Pi's TUI renderer for each frame. Depending on the terminal,
this may return a manually scrolled viewport to the bottom. Use
`/petit-chat static` if animation disrupts scrollback.

## Placement

The sprite is rendered as a non-capturing overlay anchored to the bottom-right
of the screen, then repositioned every frame to track the editor's top border
as it moves (multiline input, `/model` selector, thinking-level border
changes, …). It hides itself automatically when:

- the terminal is narrower than 32 cols or shorter than 10 rows, or
- the editor border can't be located (e.g. a full-screen overlay is open).

The feet row is composited on top of the editor's border line so the artwork
stays intact while visually resting on it. The border's live ANSI color (which
changes with thinking level / bash mode) is sampled and preserved through the
leading blank cells.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
