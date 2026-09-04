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
messages, including fresh anchors after restore and compaction, so the system
prompt remains stable. Paused, blocked, completed, and cleared transitions retire
older active-goal instructions explicitly. When a session with a paused or blocked
goal is reopened, the UI offers **Resume goal**, **Keep paused/blocked**, or
**Clear goal**. Ordinary later turns are not gated on that choice. Objective and
validation text are wrapped as untrusted user-provided data before reaching the
model.

## How the loop works

When a goal is **active**, after each `agent_settled` (turn done, no retry,
no compaction, no queued user input), the extension queues a hidden wake marker
and injects the full continuation prompt only into the next model context. The
stored session history gets the small marker, not the full objective-bearing
prompt. The continuation re-orients the agent around the objective and asks for
a requirement-by-requirement completion audit before completion.

A conservative read-only judge runs only at terminal boundaries: proposed
`goal_complete`, the final repeated `goal_block` report, and anti-spin blocking
after repeated no-tool continuations. It can veto premature completion or lazy
blocking and feed a next action into the transient continuation prompt. It does
not drive normal cycles.

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
  retry-looping. Usage/rate/quota errors get a specific resume hint. Reopening
  the session offers resume, keep, and clear choices without forcing a decision
  on every later turn.
- **Completion status** — the model marks the goal complete by calling
  `goal_complete` when current evidence proves every requirement is satisfied
  and no required work remains. A judge veto keeps the goal active and reports
  missing evidence or a next action. Transient provider failures during the
  nested judge call retry silently with abortable backoff before an unavailable
  judge is reported.
- **Blocked audit** — `goal_block` records blockers while leaving the goal
  active until the same blocker has recurred across three settled agent runs.
  At most one report counts per run, including runs with a final tool-less turn.
  At the terminal threshold, the extension passes its authoritative audit count
  to the judge because the current tool result is not yet in the transcript. The
  judge can reject the block if actionable work remains, but does not re-audit
  that counter. Resuming a blocked goal starts a fresh audit.

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
- **`goal_resume`** — always available; reactivates the existing paused or
  blocked goal and restarts auto-continuation without replacing its objective,
  validation criteria, identity, timing, or continuation history. This is the
  agent-callable equivalent of `/goal resume`. Reopening a session with a paused
  or blocked goal also offers this action in the UI.
- **`goal_clear`** — always available; retires an obsolete, superseded, cancelled,
  or unrelated goal without deleting its append-only history. It is not a
  substitute for `goal_complete` when the objective was achieved.
- **`goal_complete`** — introduced when a `/goal` first becomes active; asks the
  judge to audit current evidence, then marks the goal complete only if the
  judge allows it. It accepts an optional `summary`. It remains non-terminating
  so Pi performs the follow-up model turn that delivers the final report. The
  completion block also shows the goal's lifetime stats (active time, cycles,
  criteria, and token usage), since the overlay card hides once the goal is
  complete. Manual `/goal complete` surfaces the same stats once via a
  notification.
- **`goal_block`** — introduced when a `/goal` first becomes active; records a
  blocker and terminates the current agent run so the next report belongs to a
  fresh settled run. Optional fields can describe the blocker, attempted work,
  supporting detail, and next input; marks the goal `blocked` only after the same
  blocker repeats across three settled agent runs and the judge accepts the
  terminal block. Multiple reports in one run count once.

`goal_set`, `goal_resume`, and `goal_clear` are always registered. `goal_complete`
and `goal_block` start inactive, are added when the first goal becomes active, and
remain in the active loadout for the rest of that session. This monotonic
activation preserves deferred-tool and prompt-cache reuse across pause, block,
completion, and clear transitions. Stale `goal_complete` and `goal_block` calls
made while no goal is active are ignored silently so they do not add noisy output
to the transcript; the rendered block is hidden too.

All five tools render as the same compact 2-line transcript blocks as the native
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
• Completion denied by judge
  └ tests were not run
• Blocker rejected by judge
  └ inspect the available logs first
```

Judge veto blocks keep the collapsed branch to one viewport-fitted line and show
full denial details when expanded, matching native tool expansion behavior. Goal
set/replaced/already-active blocks use a head/tail objective preview plus one
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

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API and bundled `@earendil-works/pi-ai` compatibility completion helper.
- **Depends on extensions:** None.
- **Used by extensions:** None.
