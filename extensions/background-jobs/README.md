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

The three terminal-control tools are registered but initially inactive, keeping
their schemas out of ordinary requests. The first yielded `bash` call activates
them additively for the rest of the session, and its result names the newly
available tools and terminal ID.

For an interactive prompt, call `bash` with `tty: true`; if it yields, send the
answer with `terminal_write`. `terminal_write` also accepts literal control
characters, including `\u0003` for Ctrl+C. PTY mode uses the system `expect`
utility on macOS and `script` from util-linux on Linux, avoiding a native Node
dependency.

## User experience

Managed commands keep the same reason-first headline, bordered command, and
`│` output gutter as `better-native-pi`. Foreground completions omit terminal
metadata; once a command yields, a final muted row identifies the terminal
without mixing metadata into command output:

```text
• Running exercise live terminal updates 10s
  ╭ bash ─────────────────────────────╮
  │ for i in {1..12}; do …            │
  ╰───────────────────────────────────╯
  │ demo tick 09
  │ demo tick 10
  └ ● demo-loop-a1b2c3d4 · running · /ps
```

`terminal_write` and `job_output` use the same colored `•` headline, dim
terminal name, accent reasoning, `│` output gutter, and `└` metadata hierarchy:
`Interacted with <terminal> to <goal>`, `Waited for <terminal> to <goal>`, or
`Read from <terminal> to <goal>`.

After terminals yield into the background, the footer shows:

```text
2 background jobs running · /jobs to view
```

Commands that are still inside their initial foreground yield window do not show
this footer status.

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
- Live command cards request a TUI redraw only when output or process status changes; idle background processes do not continuously disturb terminal scrollback.
- Tool output remains below Pi's 50KB limit.
- Full UI output retains bounded head and tail sections for diagnostics.
- Session shutdown waits for SIGTERM/SIGKILL escalation.
- PTY wrapper and child process groups are both terminated to prevent orphans.
- A last-resort reaper also SIGKILLs every live job's process tree from
  `process.on('exit')` and `SIGTERM`/`SIGHUP`/`SIGINT`, so a managed terminal
  that ignores SIGTERM (`trap '' TERM`) cannot survive an ungraceful pi exit
  (crash, `emergencyTerminalExit`, signal). Without it, such jobs were
  re-parented to PID 1 and drove the render loop forever.
- Yielded command completions update their tool card and footer status without emitting desktop notifications.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/).
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
- **System/service:** `expect` on macOS or util-linux `script` on Linux for PTY sessions.
