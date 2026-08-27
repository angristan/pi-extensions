# turn-separator

A dim `─` rule between assistant messages that follow tool work, so each step
of a multi-step turn is visually separated in the transcript.

When a new assistant message starts AND the preceding step performed concrete
work (ran a tool), a custom (non-LLM) entry is appended. The preceding provider
response's time to first token (TTFT) and output throughput are persisted on the
entry and rendered at the rule's right edge:

```
────────────────────────────────────── ttft 480ms · tps 42/s ─
```

Steps longer than 60s also keep the elapsed-work label at the left edge. If the
terminal is too narrow for both labels, the per-response metrics take priority.
Older entries without metrics still render as bare or elapsed-labeled rules.
The rule intentionally leaves a tiny right margin to avoid terminal wrap
artifacts that can show up as stray `──` rows.

No config, always on. No rule before the very first assistant message.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`turn-stats`](../turn-stats/) for per-response TTFT/TPS events; separators still render without it.
- **Used by extensions:** None.
