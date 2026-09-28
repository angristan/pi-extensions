# herdr-fork

Open `/fork` and `/clone` in a new [Herdr](https://herdr.dev/) pane, tab, or
workspace.

In a Herdr-managed Pi TUI, choosing a fork point with `/fork`, `/clone`, or
`/rewind` (alias `/undo`) asks where to open the new session:

```text
Open fork in
→ Current pane
  New pane to the right
  New pane below
  New tab
  New workspace
```

`Current pane` is Pi's normal in-place fork. The other choices open the
destination at Pi's working directory, focus it, and start `pi --session <fork>`
there with `herdr agent start`. The current session is unchanged. Escape
cancels the fork.

- Forks restore the selected prompt to the new Pi's editor; clones open with an empty editor
- New tabs open in the current workspace, labeled with the session name
- The new Pi appears in Herdr's agent list as `fork-<id>` or `clone-<id>`
- It runs `pi` from `PATH`; options the current Pi was started with, such as `-e` or `--model`, are not carried over
- Unsaved sessions skip the menu and fork in place
- If Pi does not start, the new pane, tab, or workspace and the fork are removed; if Herdr cannot close it, the fork is kept for the Pi that may be running there
- Not available on Windows

The prompt is passed through an owner-only temporary file named by
`PI_HERDR_FORK_DRAFT` in the new pane's environment. The new Pi reads and
deletes it on startup, and ignores any other file the variable points to.
Drafts that no Pi picked up are deleted after a day.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
- **System/service:** [Herdr](https://herdr.dev/) 0.9.1 or newer with `HERDR_ENV` and `HERDR_PANE_ID` available to Pi.
