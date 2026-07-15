# history-search

Incremental search across your previous user prompts, inline in the editor.

`Ctrl+R` begins a reverse-i-search; typing filters all past user messages in
the current session and the matched prompt is restored live to the editor.
Cycle matches with `Ctrl+R` / `↑` (up) and `Ctrl+S` / `↓` (down); `Enter`
accepts the selected prompt (does not fork — unlike `/backtrack`). `Esc` /
`Ctrl+C` cancels; `Ctrl+U` clears the query.

```
> grep the config keys
reverse-i-search: grep_  3/5  Enter accept · Esc cancel
```

Composes with `editor-accent`: the wrapped editor forwards `borderColor` so the
accent stays fixed while searching.
