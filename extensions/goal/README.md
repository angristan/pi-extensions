# goal

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.

Track an explicit objective for the session.

The goal is a short statement (plus optional validation criteria and token
budget) that's surfaced in the `plan-progress` overlay above the plan, so you
and the agent keep it in view while working. The extension stores the goal and
emits a `goal:changed` event when it changes.

## Commands

- `/goal` — show the current goal
- `/goal set <objective>` — set or update the objective
- `/goal edit` — edit the goal document interactively
- `/goal pause` / `/goal resume` — pause/resume active-time tracking
- `/goal complete` — mark the goal done
- `/goal clear` — drop the goal

## How it renders

The `goal` extension itself doesn't render — it stores state and emits
`goal:changed`. The `plan-progress` extension subscribes and shows the active
goal at the top of the plan overlay:

```
╭ Goal · Plan 1/3 ─────────────────────────╮
● Goal Refactor the auth middleware
  budget 18% · 18,000/100,000 tokens
```

`●` = active, `◐` = paused.
