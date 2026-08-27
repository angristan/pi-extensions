# turn-stats

Per-turn timing and token-usage entries appended to the transcript after each
agent run.

After the agent settles, appends a dim separator line and a compact completion
row showing wall-clock duration + clock time, average throughput (`avg ttft`,
`avg tps`), token usage (in/out/cache), and cost — sourced from real usage, not
estimated.

Final TTFT is the arithmetic mean of measured provider-response TTFTs. Final TPS
is weighted as total output tokens divided by total generation time; it is not
an average of per-response rates, which would let tiny responses dominate.
Token usage and cost sum across the whole run.

Each finalized provider response also publishes a `turn-stats:response` event
with its output token count, TTFT, and TPS. The `turn-separator` extension uses
this event to label every tool-loop boundary without reimplementing timing.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`turn-separator`](../turn-separator/).
