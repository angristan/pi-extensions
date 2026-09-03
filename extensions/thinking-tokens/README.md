# thinking-tokens

Live token counts on Pi's collapsed thinking labels.

When `hideThinkingBlock` is enabled, Pi renders every hidden thinking block as
a static `Thinking...` line with no progress signal. This extension turns that
line into a live counter while reasoning streams:

```
Thinking… 1.2k        ← moving while the model reasons (live estimate)
Thinking... 1.23k    ← frozen when the message settles (exact count)
```

## How it works

- **Live phase:** each streaming update recomputes the count from the partial
  message's thinking blocks (so interleaved thinking adds up), estimated at
  ~4 characters per token. Providers do not report reasoning tokens mid-stream,
  so text length is the only live signal.
- **Frozen phase:** when the message settles, the count freezes to the exact
  reasoning-token figure when the provider reports one in its usage payload
  (Anthropic, OpenAI Responses, Gemini); otherwise the last estimate is kept.
  The label switches from `…` to `...` to mark the settled state.
- **Reset:** the frozen count stays visible for transcript review and clears
  when the next agent run starts.

The label is global across the transcript (a Pi API constraint), so the counter
always reflects the most recent thinking episode.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.

Works only in TUI mode; other modes leave the label untouched.
