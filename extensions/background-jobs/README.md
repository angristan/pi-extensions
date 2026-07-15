# background-jobs

Run long-lived shell commands in the background with live status, without
blocking the agent transcript.

The agent can spawn jobs via the `background_bash` tool and read/kill them via
`job_output` / `job_kill`. Each job shows a status row with a symbol:

- `●` running
- `✓` completed
- `◷` timed out
- `■` killed
- `×` failed

```
● Starting background job bun test
● run the typecheck · job-3 · running in 12s
  bun test
✓ run the typecheck · job-3 · completed in 14s
  bun test
```

## Commands

- `/jobs` — list, inspect, or stop managed background jobs
  - `/jobs output <id>` — show full output for a job
  - `/jobs kill <id>` (or `stop`) — terminate a job
