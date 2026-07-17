# goal

Track an explicit objective for the session as a **persistent, self-driving
loop**: the objective stays in view, and after each turn
the agent keeps working toward it until it's done or blocked.

Blocked status uses three-turn auditing: the same blocker must repeat across at
least three consecutive goal turns before the goal is marked blocked.

A goal is a control mode, not the default planning primitive. Ordinary coding or
research tasks—including multi-step work—should use `update_plan` instead.
Reserve goals for explicit user requests or long-running, multi-turn work that
genuinely needs automatic continuation, potentially across hours. Most tasks
should not create a goal.

The goal is a short statement plus optional **validation criteria**. A compact
summary is surfaced in its own overlay card, while the full goal is available via
`/goal-status` and injected into the system prompt on every turn. Objective and
validation text are wrapped as untrusted user-provided data before reaching the
model.

## How the loop works

When a goal is **active**, after each `agent_settled` (turn done, no retry,
no compaction, no queued user input), the extension queues a hidden wake marker
and injects the full continuation prompt only into the next model context. The
stored session history gets the small marker, not the full objective-bearing
prompt. The continuation re-orients the agent around the objective and asks for
a requirement-by-requirement completion audit before completion.

```
/goal set <objective>
        │
        ▼
┌─ agent turn ──────────────────────────────────┐
│  work toward objective (tools, edits, tests)  │
└────────────────────┬──────────────────────────┘
                     │ agent_settled
                     ▼
        ┌── maybeContinue ──┐
        │ active + idle?     │── no ──► stop (wait for user)
        │ no-tool streak    │
        │  reached 3?       │── yes ─► blocked (anti-spin)
        └──────┬─────────────┘
               │ yes
               ▼
   queue hidden wake marker + transient prompt ──► new agent turn ──► …
               │
               │ model calls goal_complete ────────────────────► complete
               │ repeated goal_block reports ──────────────────► blocked
               │ user presses Esc ─────────────────────────────► pause
```

### Safety boundaries

- **Safe-boundary continuation only** — never continues mid-turn, while
  streaming, while user input is queued, or while other work is pending.
- **Anti-spin** — no-tool continuation turns are allowed briefly, but after
  three consecutive no-tool continuations the goal is marked `blocked` instead
  of spinning forever.
- **Interruption → pause** — if you abort a turn (Esc), the goal auto-pauses
  so it doesn't immediately resume on the next boundary.
- **Provider error → blocked** — if a turn ends with a terminal provider error,
  the goal is marked `blocked` at the next safe idle boundary instead of
  retry-looping. Usage/rate/quota errors get a specific resume hint.
- **Completion status** — the model marks the goal complete by calling
  `goal_complete` when current evidence proves every requirement is satisfied
  and no required work remains.
- **Blocked audit** — `goal_block` records blockers while leaving the goal
  active until the same blocker has recurred three times. Resuming a blocked
  goal starts a fresh audit.

## Commands

- `/goal` — show the current goal status briefly
- `/goal <objective>` — set or update the objective (auto-kicks the loop;
  replacing an active, paused, or blocked goal asks for confirmation)
- `/goal edit` — edit the goal document interactively; editing a completed goal
  reactivates it and resumes the loop
- `/goal pause` / `/goal resume` — pause/resume the loop
- `/goal block` — manually mark the goal blocked
- `/goal complete` — manually mark the goal done
- `/goal clear` — drop the goal
- `/goal-status` — show the full objective, timing, blocker, and validation details

Usage: `/goal [<objective>|clear|edit|pause|resume|block|complete]`

## Goal document format

```markdown
# Goal
Reduce p95 checkout latency below 120ms

## Validation
- checkout benchmark p95 < 120ms
- correctness suite stays green
- no public API changes
```

All sections except `# Goal` are optional.

## Tools exposed to the agent

- **`goal_set`** — always available; lets the agent set (or replace) the
  durable session goal itself and start the auto-continuation loop, without a
  user running `/goal`. It is reserved for explicit user requests or
  long-running work that needs automatic continuation; ordinary multi-step work
  should use `update_plan`. Accepts an `objective`, optional `validation`
  criteria, and `replace: true` to overwrite an existing in-progress goal. A
  completed goal can be overwritten freely. The tool refuses to silently
  overwrite an active/paused/blocked goal and asks the caller to re-call with
  `replace: true`, so an in-progress goal cannot be silently redefined around
  an easier task.
- **`goal_complete`** — active only while a `/goal` is active; marks the goal
  complete and accepts an optional `summary`. The completion block also shows
  the goal's lifetime stats (active time, continuations, criteria, and token
  usage), since the overlay card hides once the goal is complete. `/goal
  complete` surfaces the same stats via a notification.
- **`goal_block`** — active only while a `/goal` is active; records a blocker.
  Optional fields can describe the blocker, attempted work, supporting detail,
  and next input; marks the goal `blocked` only after the same blocker repeats
  three times.

`goal_set` is always registered. `goal_complete` and `goal_block` are removed
from the active tool set when no goal is active. If a stale in-flight model
request still calls one of them, the call is ignored silently so it does not
add noisy "no active goal" output to the transcript — the rendered block is
hidden too.

All three tools render as the same compact 2-line transcript blocks as the native
and web tools (`renderShell: "self"`): a `• verb` headline whose bullet color
tracks the outcome (magenta while running, green on success, red for a real
blocker) over a dim `└ summary` branch. Example settled blocks:

```
• Set goal
  └ make all tests pass
• Replaced goal
  └ ship the feature
• Goal already active
  └ make all tests pass
• Completed goal
  └ Reduce p95 checkout latency below 120ms
  └ 2m 14s active · 4 continuations · 2 criteria · Usage ↓42K  ↑3K
• Goal blocked
  └ flaky CI on macOS · next: re-run after runner image bumped
• Blocker recorded
  └ flaky CI on macOS · goal remains active · 1/3
```

## How it renders

The `goal` extension stores state and renders the active goal in a dedicated,
compact overlay card so it does not crowd out live plan/edit widgets:

```
╭ Goal ● active ───────────────────────────╮
Reduce p95 checkout latency below 120ms
+4 lines · /goal-status

2m 14s active · 4 continuations · 2 criteria
Usage  ↓42K  ↑3K · cached 310K
╰──────────────────────────────────────────╯
```

Run `/goal-status` for the full objective, timing, blocker, and validation
view. Usage uses `↓` for input and `↑` for output; cache reads and writes are
shown as `cached` and `written` when present.

Status colors: `● active` (green), `● paused` (yellow), `● blocked` (red), and
`● complete` (dim).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
