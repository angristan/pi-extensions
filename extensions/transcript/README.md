# transcript

Open a full, scrollable view of the entire session transcript.

`/transcript` (or `Ctrl+Shift+T`) opens a near-fullscreen overlay (95% width,
up to 92% height with a one-row margin, centered) over every entry — user,
assistant (with thinking), tool calls + arguments, tool results — rendered
with the same styling as the live transcript, plus cleaned-up web-search
metadata.

```
/transcript

  user:      refactor the auth middleware
  assistant: I'll start by mapping the call sites
  tool:      grep { pattern: "middleware" }
             3 matches in 2 files
  ...
```

Strips pi's internal web-search HTML comments and collapses runs of blank
lines so the reading view is clean. Navigate with the usual pager keys.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`subagents`](../subagents/).
