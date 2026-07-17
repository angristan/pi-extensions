# goal

Track an explicit objective for the session as a **persistent, self-driving
loop**): the objective stays in view, and after each turn
the agent keeps working toward it until the evidence says it's done or it gets
blocked.

The goal is a short statement plus optional **validation criteria**, an optional
**token budget**, and an optional **verify command** (a shell command that must
exit 0 before completion). The goal is surfaced in the `plan-progress` overlay
above the plan, and injected into the system prompt on every turn.

## How the loop works

When a goal is **active**, after each `agent_settled` (turn done, no retry,
no compaction, no queued user input), the extension sends a silent continuation
prompt that triggers a new turn. The continuation re-orients the agent around
the objective and requires an evidence audit before completion.

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
        │ within budget?     │
        │ last turn had     │
        │  a tool call?     │── no ──► pause (anti-spin)
        └──────┬─────────────┘
               │ yes
               ▼
   send silent continuation prompt ──► new agent turn ──► …
               │
               │ model calls goal_complete (evidence-backed) ──► complete
               │ model calls goal_block ──► pause
               │ token budget hit ──► budget-limited + one summary turn
               │ user presses Esc ──► pause (interruption)
```

### Safety boundaries

- **Safe-boundary continuation only** — never continues mid-turn, while
  streaming, while user input is queued, or while other work is pending.
- **Anti-spin** — if a continuation turn makes **no tool call**, the next
  auto-continuation is suppressed and the goal is paused. The agent won't
  spin on summarizing turns.
- **Interruption → pause** — if you abort a turn (Esc), the goal auto-pauses
  so it doesn't immediately resume on the next boundary.
- **Budget enforcement** — if a `tokenBudget` is set and exceeded, the goal
  switches to `budget-limited`, stops substantive work, and sends one final
  "summarize progress + blockers" turn.
- **Evidence-based completion** — the model marks the goal complete only by
  calling the `goal_complete` tool, which requires one evidence entry per
  validation criterion. If a `verify` command is configured, it runs and must
  exit 0 before completion is allowed.
- **No caps by default** — set a `tokenBudget` if you want
  a hard stop. You are expected to monitor long-running goals.

## Commands

- `/goal` — show the current goal
- `/goal set <objective>` — set or update the objective (auto-kicks the loop)
- `/goal edit` — edit the goal document interactively
- `/goal pause` / `/goal resume` — pause/resume the loop
- `/goal complete` — manually mark the goal done
- `/goal clear` — drop the goal

## Goal document format

```markdown
# Goal
Reduce p95 checkout latency below 120ms

## Token budget
100k

## Verify
npm test

## Validation
- checkout benchmark p95 < 120ms
- correctness suite stays green
- no public API changes
```

All sections except `# Goal` are optional. `Token budget` accepts plain numbers
or `K`/`M`/`G` suffixes (`off`/`none`/`unlimited` disable it). `Verify` is a
single shell command line.

## Tools exposed to the agent

- **`goal_complete`** — mark the goal complete. Requires `evidence` (one entry
  per validation criterion) and a `summary`. Runs the `verify` command if set.
- **`goal_block`** — report the goal is blocked and pause the loop. Requires
  `blocker`, `attempted`, `evidence`, and `next_input`.

## How it renders

The `goal` extension stores state and emits `goal:changed`. The `plan-progress`
extension subscribes and shows the active goal at the top of the plan overlay:

```
╭ Goal · Plan 1/3 ─────────────────────────╮
● active  continuations 4
  Reduce p95 checkout latency below 120ms
  budget 18% · 18,000/100,000 tokens
  verify $ npm test
  ○ checkout benchmark p95 < 120ms
  ○ correctness suite stays green
```

Status colors: `● active` (green), `◐ paused` (yellow), `budget-limited`
(red), `complete` (dim).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** `plan-progress` (subscribes to `goal:changed`).
