# side-chat

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.

An ephemeral, read-only side question about the current conversation, without
changing the main transcript.

`/side <question>` asks the **current model** a one-off question with the
conversation serialized as context, and renders the answer in a collapsible
block above the editor. It does not pollute the main transcript — promote a
reply into it only when useful.

```
/side what's the likely cause of this 500?

• Side conversation · mistral/claude-opus-4-8
  what's the likely cause of this 500?

  The 500 is almost certainly the missing CSRF token in the auth
  header; the middleware checks it before the route handler runs.
```

- Requires interactive TUI mode
- Uses the active model (not a separate/cheaper one)
- Context head/tail serialized to fit the model's window
- Runs at `reasoning: "low"`, capped at 4096 output tokens
- Independent abort; cancelled on session switch/shutdown
- Promoted messages render inline as `• Promoted side answer`
