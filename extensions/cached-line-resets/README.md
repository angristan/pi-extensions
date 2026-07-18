# cached-line-resets

Caches stable TUI line work so rendering large transcript regions stays fast.

Pi rewrites every rendered line to reset terminal styles at the right columns.
This hot-patches `TUI.applyLineResets` with a bounded cache keyed on the line
string, so repeated identical lines (common in diffs, logs, and status bars)
skip the rewrite entirely. Bounded to 8k entries / 16k chars per line.

It also caches stable Kitty image positions. When an unrelated line changes
before an image but the image remains byte-for-byte identical at the same rows,
the image stays outside the changed range. Moved, resized, expanded, or changed
images still use Pi's normal delete-and-render path.

## Observability

The patch state (line cache plus stable/moved image counters) is published to
the shared `pi.cached-line-resets.patch` symbol. Line-cache statistics are
surfaced in `/doctor` under "Runtime patches and caches":

```
✓ TUI line-reset cache   4,221 entries; 3,221 hits / 38 misses; Kitty 82 stable / 4 redrawn; original retained
```

(The `· … renders · X% hit · N volatile` rows in that section are the
better-native-pi renderer cache, a separate counter.)

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
