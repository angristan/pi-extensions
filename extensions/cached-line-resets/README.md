# cached-line-resets

Caches pi's per-line ANSI reset application so rendering large transcript
regions stays fast.

Pi rewrites every rendered line to reset terminal styles at the right columns.
This hot-patches `TUI.applyLineResets` with a bounded LRU cache keyed on the
line string, so repeated identical lines (common in diffs, logs, and status
bars) skip the rewrite entirely. Bounded to 8k entries / 16k chars per line.

## Observability

The patch state (cache size, hits, misses) is published to the shared
`pi.cached-line-resets.patch` symbol and surfaced in `/doctor` under "Runtime
patches and caches":

```
✓ TUI line-reset cache   4,221 entries; 3,221 hits / 38 misses; original retained
```

(The `· … renders · X% hit · N volatile` rows in that section are the
better-native-pi renderer cache, a separate counter.)

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
