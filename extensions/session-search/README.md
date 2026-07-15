# session-search

Full-text search across all your saved sessions, with ranked results.

`/session-search <query>` streams through every session JSONL on disk
(concurrently, 6-way), scores matches, and shows ranked results in a picker.
Selecting one offers actions: resume, fork at the matching entry, or copy the
excerpt.

```
/session-search auth middleware

  Session matches for "auth middleware" (12)
  2026-07-15 · Refactor auth middleware · ~/src/pi-extensions · a1b2c3d4
  2026-07-14 · Fix proxy auth header · ~/src/acme/gateway · 9f8e7d6c
  ...
```

- 6-way concurrent file scan, 64MB cap per session
- Up to 100 results, each shown as `date · title · path · session-id`
- Result label is a `ctx.ui.select` picker; choosing one gives a follow-up
  menu (resume / fork / copy excerpt / put in editor)
