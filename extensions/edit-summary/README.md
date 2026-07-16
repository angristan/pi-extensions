# edit-summary

A passive top-right overlay summarizing files changed by `edit` and `write` during
the current agent run. While tools are running it shows **current** changes; once
the agent settles it keeps the result as the **last** turn's summary.

```text
┌────────────────────────────────────────────┐
│ File edits · current                       │
│                                            │
│ M src/auth.ts                       +18 -4 │
│ A tests/auth.test.ts                   +31 │
│                                            │
│ 2 files  +49  -4                          │
└────────────────────────────────────────────┘
```

The overlay is non-capturing, so it never takes keyboard focus from the editor.
When the `plan-progress` TODO overlay is visible, the edit summary automatically
moves below it and follows changes to the plan card's height. It returns to the
top-right when the TODO overlay closes. It also hides when a turn has no file
edits, when the terminal is narrower than 72 columns, or when there is not enough
room below the TODO card. The latest completed summary is stored in the session,
so it survives reloads and resumes.

## Commands

- `/edit-summary` — toggle the overlay
- `/edit-summary show` — enable it
- `/edit-summary hide` — hide it
- `/edit-summary toggle` — toggle it explicitly

## Counting

The extension snapshots each local file before its first `edit` or `write` in a
run and compares that snapshot with the latest contents. Counts are therefore
net changes for the run: editing and then reverting a line does not inflate the
total.

Changes made indirectly through `bash`, user shell commands, remote tool
backends, or custom mutation tools are not included.
