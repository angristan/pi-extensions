# turn-separator

A dim full-width `─` rule between assistant messages that follow tool work, so
each step of a multi-step turn is visually separated in the transcript.

When a new assistant message starts AND the preceding step performed concrete
work (ran a tool), a custom (non-LLM) entry is appended and rendered as a
single full-width dim `─` line (theme's `dim` token). Steps longer than 60s
get a centered label:

```
────────── Worked for 2m ────────────────────────────────────────────────────
```

Short steps get a bare rule. Conversational-only steps (no tool calls) don't
get a separator, so the transcript doesn't accumulate empty rules.

```
user: refactor the auth module
assistant: I'll start by reading the current code.
  └ read auth.ts · done in <1s
────────────────────────────────────────────────────────────────────────────
assistant: now I'll apply the edit.
  └ edit auth.ts · done in <1s
────────────────────────────────────────────────────────────────────────────
assistant: done, the module is refactored.
```

No config, always on. No rule before the very first assistant message.

