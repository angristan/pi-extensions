# openai-codex-fast

Adds a persistent Fast mode toggle for supported models using the `openai-codex`
provider. Fast mode requests OpenAI's priority service tier without changing the
selected model or reasoning level.

Fast mode is off by default because it consumes ChatGPT credits at a higher
rate. When enabled on a supported model, the bundled `footer` extension shows
`fast` in purple.

## Commands

```text
/fast          Toggle Fast mode
/fast on       Enable Fast mode
/fast off      Disable Fast mode
/fast status   Show the saved state and current-model support
```

The setting persists globally in `~/.pi/agent/openai-codex-fast.json`.

## Supported models

- `openai-codex/gpt-5.4`
- `openai-codex/gpt-5.5`
- `openai-codex/gpt-5.6-sol`
- `openai-codex/gpt-5.6-terra`
- `openai-codex/gpt-5.6-luna`

Other providers and models are left unchanged.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
