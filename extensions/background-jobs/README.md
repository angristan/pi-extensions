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
- `/jobs output <id>` — open the live latest-output viewer
- `/jobs stop <id>` — stop one terminal
- `/jobs stop all` — stop every active terminal after one confirmation

Each terminal uses explicit lifecycle states:

- `●` running
- `◌` stopping
- `✓` completed
- `◷` timed out
- `■` killed
- `×` failed

Once a command yields, its transcript card becomes an immutable snapshot with a
`/ps` hint. Live output and final status move to the explicitly opened viewer,
which prevents hidden or off-screen cards from redrawing long transcripts.
Completion state remains persisted invisibly for session restore without adding
a duplicate transcript entry.

## Output and lifecycle guarantees

- Polls return cursor-based deltas rather than repeating old output.
- Foreground command updates are coalesced after 250ms of quiet, with a 500ms maximum wait during continuous output.
- Yielded transcript cards are immutable and never start polling or invalidate the transcript.
- The live viewer subscribes to output/status events only while open, skips unchanged revisions, pauses redraws while unfocused, and uses a 5-second fallback check for missed events.
- Closing the viewer disposes its subscription and timers; historical jobs never subscribe.
- Collapsed cards and the viewer render bounded latest-output tails with width-keyed caches; expanded cards remain available on explicit request.
- Historical terminal interaction cards freeze elapsed time at the result's observation timestamp, so unrelated streaming renders remain byte-stable and preserve a scrolled viewport.
- Tool output remains below Pi's 50KB limit.
- Session shutdown waits for SIGTERM/SIGKILL escalation.
- PTY wrapper and child process groups are both terminated to prevent orphans.
- A last-resort reaper also SIGKILLs every live job's process tree from
  `process.on('exit')` and `SIGTERM`/`SIGHUP`/`SIGINT`, so a managed terminal
  that ignores SIGTERM (`trap '' TERM`) cannot survive an ungraceful pi exit
  (crash, `emergencyTerminalExit`, signal). Without it, such jobs were
  re-parented to PID 1 and leaked system resources.
- Yielded command completions update footer status and any open live viewer without emitting desktop notifications or mutating historical transcript rows.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/).
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
- **System/service:** `expect` on macOS or util-linux `script` on Linux for PTY sessions.
