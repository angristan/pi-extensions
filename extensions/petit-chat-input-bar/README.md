# petit-chat-input-bar

A tiny static companion sprite that sits above the editor (a la Vibe's petit
chat). Purely cosmetic — no commands, no config.

The pet is drawn in its neutral pose, anchored just above the input bar's top
border so its feet share the border row:

```
⠦ Working...                                                                    ⡠⣒⠄  ⡔⢄⠔⡄
                                                                               ⢸⠸⣀⡔⢉⠱⣃⡢⣂⡣
─────────────────────────────────────────────────────────────────────────────────⠉⠒⠣⠤⠵⠤⠬⠮⠆──

────────────────────────────────────────────────────────────────────────────────────────────
Petit Chat World Domination │ ctx 21%/262K │ ↓ 314K cached 2.35M hit 88% │ ↑ 31K │ $0.70
```

## Why it's static

The sprite never animates. Pi periodically re-renders the TUI, and each render
resets the scrollback viewport to the bottom — so a per-frame animation would
yank the view down every tick. Keeping the pet on a single neutral frame avoids
that entirely while still giving the input bar a little personality.

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
