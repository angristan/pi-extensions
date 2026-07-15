# turn-timing

Per-turn timing and token-usage entries appended to the transcript after each
agent run.

After the agent settles, appends a compact completion row showing wall-clock
duration + clock time, throughput (ttft, tps), token usage (in/out/cache), and
cost — sourced from real usage, not estimated.

```
◷ 2m 04s 23:47 │ ttft 480ms tps 42.1 │ ↓4210 (3940 cached) ↑318 │ cache 94% │ $0.21
```

Throughput renders the **last finalized provider response** (not an average),
since ttft/tps are inherently per-request. Token usage and cost sum across the
whole run.
