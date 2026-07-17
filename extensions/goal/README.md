# goal

Track an explicit objective for the session as a **persistent, self-driving
loop**: the objective stays in view, and after each turn
the agent keeps working toward it until the evidence says it's done or it gets
blocked.

Blocked status uses three-turn auditing: the same blocker must repeat across at
least three consecutive goal turns before the goal is marked blocked.

The goal is a short statement plus optional **validation criteria** and an
optional **verify command** (a shell command that must exit 0 before
completion). The goal is surfaced in its own overlay card and injected into the
system prompt on every turn.

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
        │ no-tool streak    │
        │  reached 3?       │── yes ─► blocked (anti-spin)
        └──────┬─────────────┘
               │ yes
               ▼
   send silent continuation prompt ──► new agent turn ──► …
               │
               │ model calls goal_complete (evidence-backed) ──► complete
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
- **Evidence-based completion** — the model marks the goal complete only by
  calling the `goal_complete` tool, which requires one evidence entry per
  validation criterion. If a `verify` command is configured, it runs and must
  exit 0 before completion is allowed.
- **Blocked audit** — `goal_block` records blockers while leaving the goal
  active until the same blocker has recurred three times. Resuming a blocked
  goal starts a fresh audit.

## Commands

- `/goal` — show the current goal
- `/goal <objective>` — set or update the objective (auto-kicks the loop)
- `/goal edit` — edit the goal document interactively
- `/goal pause` / `/goal resume` — pause/resume the loop
- `/goal block` — manually mark the goal blocked
- `/goal complete` — manually mark the goal done
- `/goal clear` — drop the goal

Usage: `/goal [<objective>|clear|edit|pause|resume|block|complete]`

## Goal document format

```markdown
# Goal
Reduce p95 checkout latency below 120ms

## Verify
npm test

## Validation
- checkout benchmark p95 < 120ms
- correctness suite stays green
- no public API changes
```

All sections except `# Goal` are optional. `Verify` is a single shell command
line.

## Tools exposed to the agent

- **`goal_complete`** — mark the goal complete. Requires `evidence` (one entry
  per validation criterion) and a `summary`. Runs the `verify` command if set.
- **`goal_block`** — record a blocker. Requires `blocker`, `attempted`,
  `evidence`, and `next_input`; marks the goal `blocked` only after the same
  blocker repeats three times.

## How it renders

The `goal` extension stores state and renders the active goal in a dedicated
overlay card:

```
╭ Goal active ─────────────────────────────╮
Reduce p95 checkout latency below 120ms

Active time    2m 14s
Continuations  4
Verify         $ npm test

Validation
  ○ checkout benchmark p95 < 120ms
  ○ correctness suite stays green
╰──────────────────────────────────────────╯
```

Status colors: `● active` (green), `◐ paused` (yellow), `blocked` (red),
`complete` (dim).

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
