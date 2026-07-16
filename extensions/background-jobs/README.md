# background-jobs

Run quick, long-lived, and interactive shell commands through managed terminal
sessions without blocking the agent or losing track of child processes.

## Agent tools

- `bash` — the single default command tool
  - quick commands return their final output normally
  - commands still running after `yield-time_ms` return a terminal ID
  - `tty: true` allocates a PTY for prompts, REPLs, watch processes, and control characters
- `terminal_write` — write characters to a yielded terminal or poll with empty input
- `job_output` — read only output produced since the previous cursor
- `job_kill` — stop one terminal after explicit confirmation

`terminal_exec` and `background_bash` remain registered for resumed-session
compatibility but are removed from the active tool set in favor of `bash`.

For an interactive prompt, call `bash` with `tty: true`; if it yields, send the
answer with `terminal_write`. `terminal_write` also accepts literal control
characters, including `\u0003` for Ctrl+C. PTY mode uses the system `expect`
utility on macOS and `script` from util-linux on Linux, avoiding a native Node
dependency.

## User experience

While terminals are active, the footer shows:

```text
2 background jobs running · /jobs to view
```

Commands:

- `/jobs` — list terminals with status, duration, and latest output
- `/ps` — alias for `/jobs`
- `/jobs output <id>` — open the full live output viewer
- `/jobs stop <id>` — stop one terminal
- `/jobs stop all` — stop every active terminal after one confirmation

Each terminal uses explicit lifecycle states:

- `●` running
- `◌` stopping
- `✓` completed
- `◷` timed out
- `■` killed
- `×` failed

The original tool card updates from running to its final state. Completion state
is persisted invisibly so resumed sessions render the same final card without a
duplicate transcript entry.

## Output and lifecycle guarantees

- Polls return cursor-based deltas rather than repeating old output.
- Tool output remains below Pi's 50KB limit.
- Full UI output retains bounded head and tail sections for diagnostics.
- Session shutdown waits for SIGTERM/SIGKILL escalation.
- PTY wrapper and child process groups are both terminated to prevent orphans.
