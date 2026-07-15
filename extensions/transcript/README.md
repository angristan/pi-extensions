# transcript

Open a full, scrollable view of the entire session transcript.

`/transcript` (or `Ctrl+Shift+T`) opens a near-fullscreen overlay (95% width,
centered) over every entry — user, assistant (with thinking), tool calls +
arguments, tool results — rendered with the same styling as the live
transcript, plus cleaned-up web-search metadata.

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
