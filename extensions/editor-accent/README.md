# editor-accent

Pins the editor (input bar) border to a fixed accent color, overriding pi's
default of recoloring it per thinking level / model / bash mode.

Default accent is **Mistral Vibe orange** (`#FF8205`). Any hex color works.

## Config

Override via `~/.pi/agent/editor-accent.json` (accepts `#RRGGBB` or `#RGB`):

```json
{ "color": "#00AAFF" }
```

The same accent is reused by `plan-progress` for its box border, so both track
one color. Missing/invalid config falls back to Vibe orange.

```
╭──────────────────────────────────────╮   ← accent border, fixed
│ > _                                   │
╰──────────────────────────────────────╯
```
