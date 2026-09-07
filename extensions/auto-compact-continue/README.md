# auto-compact-continue

Automatically continues the agent after pi triggers threshold-based context compaction.

Pi can stop when threshold compaction interrupts a tool-use turn before its next assistant response. This extension waits for the run to settle, then sends a hidden fallback continuation only if Pi did not resume the turn itself.

Only **threshold** compaction during an interrupted tool-use turn is eligible. Completed assistant responses, native continuations, manual `/compact`, and overflow recovery are left untouched. When `context-management` replaces threshold compaction with a no-summary rollover, the fallback points the model to durable notes and searchable session history instead of claiming that a summary exists.

```
[context threshold reached → pi compacts or rolls over]
[agent continues automatically from the summary or durable context notes]
```

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
