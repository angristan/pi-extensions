# goal

Track an explicit objective for the session as a **persistent, self-driving
loop**: the objective stays in view, and after each turn
the agent keeps working toward it until it's done or blocked.

Blocked status uses settled-run auditing: the same blocker must repeat across at
least three consecutive settled goal runs before the goal is marked blocked. A
run can contain a `goal_block` tool turn and a final tool-less follow-up turn;
only one matching report counts for that whole run.

A goal is a control mode, not the default planning primitive. Ordinary coding or
research tasks—including multi-step work—should use `update_plan` instead.
Reserve goals for explicit user requests or long-running, multi-turn work that
genuinely needs automatic continuation, potentially across hours. Most tasks
should not create a goal.

The goal is a short statement plus optional **validation criteria**. A compact
summary is surfaced in its own overlay card, while the full goal is available via
`/goal-status`. Goal lifecycle updates are appended as hidden model-context
messages, including fresh **active-goal** anchors after restore and compaction, so
the system prompt remains stable. Before each model call, older anchors are pruned
from the temporary context so only the latest persisted goal instruction remains.
Paused, blocked, completed, and cleared transitions retire older active-goal
instructions once; they are not re-anchored later because they must not override
newer work. When a session with a paused or blocked goal is reopened, the UI
offers **Resume goal**, **Keep paused/blocked**, or **Clear goal**. Ordinary later
turns are not gated on that choice. Objective and validation text are wrapped as
untrusted user-provided data before reaching the model.

## How the loop works

When a goal is **active**, after each `agent_settled` (turn done, no retry,
no compaction, no queued user input), the extension queues a hidden wake marker
and injects the full continuation prompt only into the next model context. The
stored session history gets the small marker, not the full objective-bearing
prompt. The continuation re-orients the agent around the objective and asks for
a requirement-by-requirement completion audit before completion.

User-originated input (interactive or RPC) preempts automatic continuation. The
next agent turn must reconcile that request with the active goal by keeping it, revising its complete
objective and validation criteria, or pausing it. Revisions preserve the goal's
identity, timing, continuation count, and append-only history. If reconciliation
is missing or invalid when the turn settles, the extension pauses instead of
resuming the older objective.

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
               │ user request
               ▼
       goal_reconcile: keep ────────────────────────────────────► continue
                       revise ──────────────────────────────────► continue
                       pause / unresolved ──────────────────────► pause
```

### Safety boundaries

- **Safe-boundary continuation only** — never continues mid-turn, while
  streaming, while user input is queued, or while other work is pending.
- **Anti-spin** — no-tool continuation turns are allowed briefly, but after
  three consecutive no-tool continuations the goal is marked `blocked` instead
  of spinning forever.
- **Interruption → pause** — if you abort a turn (Esc), the goal auto-pauses
  so it doesn't immediately resume on the next boundary.
- **User request → reconciliation** — user-originated input marks reconciliation as
  pending. `goal_complete`, `goal_block`, `goal_resume`, and replacement through
  `goal_set` reject the transition until the agent calls `goal_reconcile`. An
  unresolved or invalid reconciliation pauses the loop at the next safe boundary.
- **Provider error → pause** — if a turn ends with a terminal provider error, the
  goal is paused at the next safe idle boundary instead of retry-looping.
  Usage/rate/quota errors get a specific resume hint. Reopening the session offers
  resume, keep, and clear choices without forcing a decision on every later turn.
- **Deterministic completion** — `goal_complete` marks the goal complete directly
  when the agent reports that current evidence satisfies every requirement. No
  nested model call can veto or reinterpret that transition.
- **Blocked audit** — `goal_block` records blockers while leaving the goal active
  until the same blocker has recurred across three settled agent runs. At most
  one report counts per run, including runs with a final tool-less turn. The
  third matching report marks the goal blocked directly. Resuming starts a fresh
  audit.

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
  an easier task. It also refuses replacement while user-request reconciliation
  is pending.
- **`goal_resume`** — always available; reactivates the existing paused or
  blocked goal and restarts auto-continuation without replacing its objective,
  validation criteria, identity, timing, or continuation history. It rejects an
  already-active goal, including one awaiting reconciliation. This is the
  agent-callable equivalent of `/goal resume`. Reopening a session with a paused
  or blocked goal also offers this action in the UI.
- **`goal_clear`** — always available; retires an obsolete, superseded, cancelled,
  or unrelated goal without deleting its append-only history. It is not a
  substitute for `goal_complete` when the objective was achieved.
- **`goal_reconcile`** — available only while a user request is awaiting
  reconciliation; resolves it with `keep`, `revise`, or `pause`. Revision replaces
  the effective objective and validation criteria while preserving goal identity,
  timing, continuation history, and prior persisted revisions.
- **`goal_complete`** — introduced when a `/goal` first becomes active; marks the
  goal complete directly and accepts an optional `summary`. It remains
  non-terminating so Pi performs the follow-up model turn that delivers the final
  report. The completion block also shows the goal's lifetime stats (active time,
  cycles, criteria, and token usage), since the overlay card hides once the goal
  is complete. Manual `/goal complete` surfaces the same stats once via a
  notification.
- **`goal_block`** — introduced when a `/goal` first becomes active; records a
  blocker and terminates the current agent run so the next report belongs to a
  fresh settled run. Optional fields can describe the blocker, attempted work,
  supporting detail, and next input; the same blocker must repeat across three
  settled agent runs. Multiple reports in one run count once.

`goal_set`, `goal_resume`, and `goal_clear` are always registered.
`goal_complete` and `goal_block` start inactive, are added when the first goal
becomes active, and remain in the active loadout for the rest of that session.
`goal_reconcile` is added only while reconciliation is pending and removed as soon
as it resolves or the goal pauses. Stale queued calls are ignored silently so they
do not add noisy output to the transcript; the rendered block is hidden too.

All six tools render as the same compact 2-line transcript blocks as the native
and web tools (`renderShell: "self"`): a `• verb` headline whose bullet color
tracks the outcome (magenta while running, green on success, red for a real
blocker) over a dim `└ summary` branch. Example settled blocks:

```
• Set goal
  └ make all tests pass
• Replaced goal
  └ ship the feature
• Resumed goal
  └ ship the feature
• Cleared goal
  └ monitor the old rollout
• Goal already active
  └ make all tests pass
• Completed goal
  └ Reduce p95 checkout latency below 120ms
  └ 2m 14s active · 4 cycles · 2 criteria · Usage ↓42K  ↑3K
• Goal blocked
  └ flaky CI on macOS · next: re-run after runner image bumped
• Blocker recorded
  └ flaky CI on macOS · goal remains active · 1/3
• Revised goal
  └ validate 100k hosts and sharding
• Kept goal
  └ ship the feature
• Paused goal
  └ inspect another repository
```

Goal set/replaced/already-active blocks use a head/tail objective preview plus one
preserved metadata group such as `3 criteria, Ctrl+O for full details`, then
expand to the full objective and validation text.

## How it renders

The `goal` extension stores state and renders the active goal in a dedicated,
compact overlay card so it does not crowd out live plan/edit widgets:

```
╭ Goal ● active ───────────────────────────╮
Reduce p95 checkout latency below 120ms
+4 lines · /goal-status

2m 14s active · 4 cycles · 2 criteria
Usage  ↓42K  ↑3K · cached 310K
╰──────────────────────────────────────────╯
```

Run `/goal-status` for the full objective, timing, blocker, and validation
view. A cycle is one automatic pass through the goal loop, including the initial
kickoff. Usage uses `↓` for input and `↑` for output; cache reads and writes are
shown as `cached` and `written` when present. Usage totals are refreshed on
message, compaction, restore, and branch lifecycle events, then reused across
repaints so rendering does not rescan the transcript.

Status colors: `● active` (green), `● paused` (yellow), `● blocked` (red), and
`● complete` (dim).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
