# plan-progress

Track a flat or nested multi-step plan as a collapsible overlay above the
editor, and expose a tool the agent can call to maintain it.

The agent maintains the plan via the `update_plan` tool; this extension owns the
tool logic, validation, persistence, agent guidance, and plan-section rendering.
Each update remains in its append-only tool result instead of rebuilding the
system prompt with mutable plan state, preserving prompt-prefix cache reuse. The
package's generic `overlay-stack` only supplies consistent card framing and places
that section on screen. If the `goal` extension is active, its separate card can
appear above the plan.

`/plan-status` shows the complete hierarchy:

```
• Updated Plan
  ├─ ◆ Implementation · 1/3
  │  ├─ ◆ Backend · 1/2
  │  │  ├─ ✓ Ship API
  │  │  └─ ● Run invariants
  │  └─ ○ Write docs
  └─ ◇ Release · 0/1
     └─ ○ Publish
```

The narrower overlay expands the group that contains the active task and
collapses inactive groups to their `completed/total` summary. Its card uses 50
columns, and its tree starts at the card's content edge without an extra plan
indent. Available vertical detail is unchanged. Optional item descriptions stay
hidden there except for the active leaf, whose description uses at most two
rows. `/plan-status` and expanded tool results show every description. Totals
count leaf tasks, not grouping rows.

- `✓` completed (strikethrough)
- `●` in-progress task; `◆` group that contains it
- `○` pending task; `◇` pending group

## Commands

- `/plan-status` — show the current plan inline
- `/plan-clear` — clear the plan

## Tool

- `update_plan` — agent-facing; replace the complete plan. Each ordered row has
  `step`, an optional `description` of up to 500 characters, optional `depth`
  (0–8), and a leaf `status` of `pending`, `in_progress`, or `completed`.
  Descriptions hold context or completion criteria that do not fit a concise
  step title. A row becomes a parent when the next row has a greater depth; its
  status and progress are derived, so its input status can be omitted. Depth
  starts at 0 and can increase by at most one row at a time. Flat plans remain
  compatible. The tool runs sequentially so the agent sees each update before
  continuing.

Box border uses the accent color from `accent-color`.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`overlay-stack`](../overlay-stack/).
- **Used by extensions:** None.
