# auto-compact-continue

Automatically continues the agent after pi triggers threshold-based context compaction.

Pi intentionally stops after auto-compaction so you can review. This extension queues a hidden follow-up so the agent resumes on its own — without repeating already-completed work.

Only acts on **threshold** compaction. Manual `/compact` and overflow recovery are left untouched. When `context-management` replaces threshold compaction with a no-summary rollover, the continuation points the model to durable notes and searchable session history instead of claiming that a summary exists.

```
[context threshold reached → pi compacts or rolls over]
[agent continues automatically from the summary or durable context notes]
```

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
