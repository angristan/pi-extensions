# herdr-process

Runs long-lived foreground commands in visible sibling [Herdr](https://herdr.dev/)
panes. It is intended for development servers, watch tasks, log tails, and other
processes that should remain visible while Pi continues working.

The extension activates only in a Herdr-managed Pi TUI. It adds one
`herdr_process` tool with these actions:

- `start` — split the current pane, label the new pane, and run a command there
- `list` — list panes created by this Pi session
- `read` — read bounded recent output from one created pane
- `status` — inspect its current foreground process
- `input` — send text and optionally Enter
- `interrupt` — send Ctrl+C

`start` keeps focus in Pi. For the first automatic split, a very wide pane opens
to the right; a taller or half-monitor pane opens below to preserve width. Each
later process alternates direction, producing a useful mixed layout. An explicit
direction overrides that choice and becomes the basis for the next alternation.
The command runs at Pi's current working directory and stays attached to Herdr's
terminal.

Processes are intentionally not stopped during Pi session shutdown or reload.
They continue while Herdr is detached and remain visible for manual control.
The control actions accept only pane IDs created by the current Pi session;
that ownership is restored from persisted tool results after a reload or resume.
The extension never closes panes.

Recent output is read as plain text and capped at Pi's normal tool-output limit
of 2,000 lines or 50 KB. `input` never echoes the submitted text in its result.

This explicit tool is used instead of guessing whether a normal `bash` command
will become long-running. A process cannot be moved into another terminal after
it has already started, and command-name heuristics would route finite commands
incorrectly.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/) for shared tool rendering helpers.
- **Used by extensions:** None.
- **System/service:** [Herdr](https://herdr.dev/) with `HERDR_ENV` and `HERDR_PANE_ID` available to Pi.
