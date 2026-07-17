# accent-color

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`doctor`](../doctor/), [`overlay-stack`](../overlay-stack/).

Pins the editor (input bar) border to a fixed accent color, overriding pi's
default of recoloring it per thinking level / model / bash mode. The same
accent is shared by `plan-progress`, `doctor`, and other overlays for their
borders, so everything tracks one color.

Default accent is **Mistral Vibe orange** (`#FF8205`). Any hex color works.

## Config

Override via `~/.pi/agent/accent-color.json` (accepts `#RRGGBB` or `#RGB`):

```json
{ "color": "#00AAFF" }
```

Missing/invalid config falls back to Vibe orange.

```
╭──────────────────────────────────────╮   ← accent border, fixed
│ > _                                   │
╰──────────────────────────────────────╯
```
