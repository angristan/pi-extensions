# working-timer

Adds a small `rail-3` spinner, phase text, and a live elapsed timer to pi's built-in working row:

```
[•··] Thinking (2m 17s • escape to interrupt)
[·•·] Running tools (2m 18s • escape to interrupt)
```

The spinner moves a single accent dot inside a dim three-cell rail. The phase
text stays stable and switches only when the agent lifecycle changes, using
labels such as `Waiting for model`, `Thinking`, `Running tools`, `Retrying`,
and `Compacting`. The elapsed/interrupt suffix is dimmed to keep the row quiet.
The interrupt hint follows pi's configured keybinding. The timer covers the
complete user-visible run. It keeps counting across provider retries, automatic
compaction and retry, and queued continuations, then resets when pi fully
settles.

Pi's dedicated retry and compaction loaders keep their native messages. The
elapsed timer resumes when the normal working row returns.

No config, always on.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
