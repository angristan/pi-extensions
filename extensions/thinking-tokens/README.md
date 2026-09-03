# thinking-tokens

Live thinking-token progress without transcript redraws.

When `hideThinkingBlock` is enabled, Pi renders every hidden thinking block as
a static `Thinking...` label with no progress signal. This extension adds a
live counter while reasoning streams, as a one-line widget above the editor:

```
⠋ Thinking… 1.2k
```

## Why a widget and not the label

Driving the hidden-thinking label live (`setHiddenThinkingLabel`) re-renders
every assistant message component on each push, and any change to a transcript
line above the viewport forces a full-screen redraw with scrollback replay.
Per thinking token, that storms the renderer. The widget sits at the bottom of
the screen, so updates only diff the changed bottom rows and the transcript is
never invalidated.

## How it works

- **Live phase:** each streaming update recomputes the count from the partial
  message's thinking blocks (interleaved thinking adds up), estimated at ~4
  characters per token — providers do not report reasoning tokens mid-stream.
  Updates only mark state dirty; a single 100ms tick pushes at most one widget
  render per interval, so token bursts cannot queue renders.
- **Settle:** when the message ends, the exact provider-reported reasoning
  count (Anthropic, OpenAI Responses, Gemini) replaces the estimate, the widget
  disappears, and the count is published on the shared event bus
  (`thinking-tokens:episode` with `{ reasoningTokens, exact }`) for other
  extensions to consume. Aborted streams are cleared by `agent_settled`.

TUI mode only; other modes never show the widget.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None (the `thinking-tokens:episode` event is free to consume).
