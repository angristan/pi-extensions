# turn-stats

Per-turn timing and token-usage entries appended to the transcript after each
agent run.

After the agent settles, appends a dim separator line and a compact completion
row showing wall-clock duration + clock time, average response performance
(`ttft`, `tps`), token usage (in/out/cache), and cost — sourced from real usage,
not estimated.

Response TTFT runs from the provider request to the first non-empty text,
thinking, or tool-call delta. Empty block starts do not count. For providers
that do not stream deltas, non-empty completed text/thinking blocks or a
completed tool call provide a fallback. Streamed thinking can arrive before
visible answer text, so TTFT is not necessarily time to the first visible answer.

Response TPS divides provider-reported output tokens by the time from that first
content to response completion, falling back to request start if no content event
was observed. Output token counts can include hidden reasoning.

Final TTFT is the arithmetic mean of measured provider-response TTFTs. Final TPS
is weighted as total output tokens divided by total generation time; it is not
an average of per-response rates, which would let tiny responses dominate.
Tool execution time is excluded from TTFT/TPS but included in wall-clock duration.
Token usage and cost sum across the whole run. Saved historical timings are not
recalculated.

Each finalized provider response also publishes a `turn-stats:response` event
with its output token count, TTFT, and TPS. The `turn-separator` extension uses
this event to label every tool-loop boundary without reimplementing timing.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`turn-separator`](../turn-separator/).
