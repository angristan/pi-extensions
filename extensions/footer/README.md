# footer

A status line below the transcript showing session, model, context usage, and
cumulative token and cost totals.

Updates live as the agent runs: context percentage against the active model's
window, and running token and cost totals across the session. Child-agent usage
is included directly in those totals without a separate subtotal. The context
percentage remains specific to the parent conversation because every child has
an independent context window. While the agent is active,
the terminal window title gets a spinner prefix so you can spot activity from
another tab. Attention titles from interactive extensions temporarily take
priority over the spinner.

```
 pi-extensions · claude-opus-4-8 high · ctx 42%/200K · ↑ 318 · $0.21      ~/src/pi-extensions │ main
```

- Thread, model + thinking level, context, usage, and cost on the left
- Directory and git branch right-aligned so they stay anchored as session titles change
- Context % with a 12k-token baseline so small sessions don't show 0%
- Cumulative input, output, cache, and cost totals, including child agents
- Cost from token usage × provider pricing (input/output/cache)
- Session-only window title while idle, including after startup or session restore
- Window-title spinner (OSC 0) while the agent is running
- Softened Catppuccin-Mocha-derived palette that adapts to the active theme
- Purple `fast` status beside the model when the bundled OpenAI Codex Fast mode is enabled
- Model-adjacent badges from other extensions through the `footer:model-badge` event
- Responsive layout that removes cache details, git, cost, output, input,
  directory, model, and context in that order; the session title remains

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None; automatically includes durable usage records from `subagents` and attention-title overrides from `questions` when present.
- **Used by extensions:** `questions` optionally uses its terminal-title ownership support. Other extensions can place a short badge beside the model with `pi.events.emit("footer:model-badge", { source: "my-extension", text: "priority" })`; omit `text` to clear it.
