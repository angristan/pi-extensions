# wakatime

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
- **System/service:** `wakatime-cli` on `PATH` and a configured WakaTime API key.

Tracks file activity from Pi with an existing
[`wakatime-cli`](https://github.com/wakatime/wakatime-cli) installation.

The extension never downloads, installs, or updates anything. It activates only
when `wakatime-cli` is executable on `PATH`; otherwise it remains a clean no-op.

## Requirements

1. Install `wakatime-cli` yourself and ensure it is on `PATH`.
2. Configure your API key in `~/.wakatime.cfg`, or in
   `$WAKATIME_HOME/.wakatime.cfg` when `WAKATIME_HOME` is set.

## Tracking

- Successful `read`, `edit`, and `write` tool calls are tracked.
- Failed calls, searches, and shell commands are ignored.
- Edits and writes report net AI line changes.
- New files include WakaTime's `--write` marker.
- Heartbeats are rate-limited to once per minute per project, with pending
  activity flushed when the agent settles or the session shuts down.
- Parallel edits to the same file are aggregated before line changes are
  calculated.

Heartbeats send the file path, project folder, AI line change count, category
`ai coding`, and plugin identifier to WakaTime through the installed CLI.

## Command

- `/wakatime` — show whether the CLI was detected, its path, the number of
  successful heartbeats, and the latest error (if any).

## State

The rate-limit timestamp is stored in `~/.wakatime/pi-<project-hash>.json`, or
under `$WAKATIME_HOME` when configured. No state is written when the CLI is not
installed.
