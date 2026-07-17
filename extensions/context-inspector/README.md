# context-inspector

Inspect where your context window is being spent.

`/context` opens a breakdown of every token category in the current session so
you can see what's eating your budget before you hit a compaction:

- User messages
- Tool results, tool calls & arguments
- Assistant reasoning, assistant answers
- Compaction summaries, branch summaries
- Custom context messages

```
/context

Used 28,492 / 200,000 (14.2%)

User messages              8,200
Tool results               4,100
Assistant reasoning        2,200
Tool calls and arguments     912
Compaction summaries      12,000
Branch summaries           1,840
```

Categories are sorted by token count (descending). Estimates use pi's tokenizer;
per-entry estimates degrade gracefully if a message can't be tokenized directly.
Also reports the provider's own token count when available, plus the largest
individual entries.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
