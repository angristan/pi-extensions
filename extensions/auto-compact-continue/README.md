# auto-compact-continue

Automatically continues the agent after pi triggers threshold-based context compaction.

Pi intentionally stops after auto-compaction so you can review. This extension queues a hidden follow-up so the agent resumes on its own — without repeating already-completed work.

Only acts on **threshold** compaction. Manual `/compact` and overflow recovery are left untouched.

```
[context threshold reached → pi compacts]
[agent continues automatically: "Continue the current task from the compacted summary..."]
```
