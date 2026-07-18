# working-timer

Adds a live elapsed timer to pi's built-in working row:

```
⠹ Working (2m 17s • escape to interrupt)
```

The interrupt hint follows pi's configured keybinding. The timer covers the
complete user-visible run. It keeps counting across
provider retries, automatic compaction and retry, and queued continuations,
then resets when pi fully settles.

Pi's dedicated retry and compaction loaders keep their native messages. The
elapsed timer resumes when the normal working row returns. When a live tool
image appears, the displayed elapsed value freezes for the rest of that run so
periodic working-row redraws do not retransmit the image; normal tool and model
updates continue.

No config, always on.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`image-store`](../image-store/) for live-image redraw suspension.
- **Used by extensions:** None.
