# turn-separator

A dim `─` rule between assistant messages that follow tool work, so each step
of a multi-step turn is visually separated in the transcript.

When a new assistant message starts AND the preceding step performed concrete
work (ran a tool), a custom (non-LLM) entry is appended and rendered as a dim
rule. Steps longer than 60s get a label:

```
────────── Worked for 2m ────────────────────────────────────────────────────
```

Short steps get a bare rule. The rule intentionally leaves a tiny right margin
to avoid terminal wrap artifacts that can show up as stray `──` rows.

No config, always on. No rule before the very first assistant message.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
