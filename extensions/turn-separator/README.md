# turn-separator

A dim full-width `─` rule between turns, so each exchange that did work is
visually separated in the transcript.

After each agent run settles, appends a custom (non-LLM) entry rendered as a
single full-width dim `─` line (colored via the theme's `dim` token). Turns
longer than 60s get a centered label:

```
────────── Worked for 2m ────────────────────────────────────────────────────
```

Short turns get a bare rule. **Only turns that performed concrete work** (ran
at least one tool) get a separator — purely conversational turns skip it so the
transcript doesn't accumulate empty rules.

No config, always on. No rule on the very first turn.
