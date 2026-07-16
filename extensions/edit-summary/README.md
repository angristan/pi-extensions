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
It hides automatically when a turn has no file edits and on terminals narrower
than 72 columns. The latest completed summary is stored in the session, so it
survives reloads and resumes.

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
