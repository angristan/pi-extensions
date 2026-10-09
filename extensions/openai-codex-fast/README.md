# openai-codex-fast

Adds a persistent Fast mode toggle for the `openai-codex` provider. When enabled,
it sets `service_tier: "priority"` on requests without changing the selected model
or reasoning level. There is no model-name allowlist, so new model IDs do not
need an extension update. The API decides whether it accepts priority.

Fast mode is off by default because priority service can consume ChatGPT credits
at a higher rate. The bundled `footer` extension shows `fast` in purple when
priority is requested. The badge does not confirm that the server used priority.

With another provider or no selected model, the footer shows no fast-mode badge
and requests are left unchanged. An explicit OpenAI Codex API error that rejects
priority shows `fast unavailable` and a warning. The extension
leaves the original error unchanged and sends no fallback request. Ordinary
errors such as rate limits and timeouts do not change the badge.

The saved preference stays on after a rejection. The next request still asks for
priority and restores the `fast` badge; use `/fast off` to stop requesting it.
Rejection state is not persisted and clears when switching models or starting
a session.

## Commands

```text
/fast          Toggle Fast mode
/fast on       Enable Fast mode
/fast off      Disable Fast mode
/fast status   Explain the saved state and current-model request behavior
```

The setting persists in `$PI_CODING_AGENT_DIR/openai-codex-fast.json`
(defaults to `~/.pi/agent/openai-codex-fast.json`).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
