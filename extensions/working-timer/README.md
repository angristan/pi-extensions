# working-timer

Adds phase text and a live elapsed timer to pi's built-in working row, using
Pi's native accent spinner by default:

```
⠹ Thinking (2m 17s • escape to interrupt)
⠸ Running tools (2m 18s • escape to interrupt)
```

The phase text stays stable and switches only when the agent lifecycle changes,
using labels such as `Waiting for model`, `Thinking`, `Running tools`,
`Retrying`, and `Compacting`. The elapsed/interrupt suffix is dimmed to keep the
row quiet.
The interrupt hint follows pi's configured keybinding. The timer covers the
complete user-visible run. It keeps counting across provider retries, automatic
compaction and retry, and queued continuations, then resets when pi fully
settles.

Pi's dedicated retry and compaction loaders keep their native messages. The
elapsed timer resumes when the normal working row returns.

## Config

Optional `~/.pi/agent/working-timer.json`:

```json
{
  "spinner": "native"
}
```

Supported spinner styles:

- `native` — Pi's native accent spinner (default)
- `rail-3` — compact three-cell rail
- `rail-3-eased` — compact rail with tiny edge holds

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
