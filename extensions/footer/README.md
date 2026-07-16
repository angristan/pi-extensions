# footer

A status line below the transcript showing session, model, context usage, and
cumulative cost.

Updates live as the agent runs: context percentage against the active model's
window, and running cost totals across the session. While the agent is active,
the terminal window title gets a spinner prefix so you can spot activity from
another tab.

```
 pi-extensions · main · claude-opus-4-8 high   ctx 42%/200K · ↑ 318 · $0.21
```

- Thread/path, git branch, model + thinking level
- Context % with a 12k-token baseline so small sessions don't show 0%
- Cost from token usage × provider pricing (input/output/cache)
- Window-title spinner (OSC 0) while the agent is running
- Softened Catppuccin-Mocha-derived palette that adapts to the active theme
- Purple `fast` status beside the model when the bundled OpenAI Codex Fast mode is enabled
