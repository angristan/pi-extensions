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
elapsed timer resumes when the normal working row returns.

No config, always on.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
