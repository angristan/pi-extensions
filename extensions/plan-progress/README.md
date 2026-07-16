# plan-progress

Track a multi-step plan as a collapsible overlay above the editor, and expose a
tool the agent can call to maintain it.

The agent maintains the plan via the `update_plan` tool; this extension owns the
tool logic, validation, persistence, prompt guard, and plan-section rendering.
The package's generic `overlay-stack` only supplies the shared frame and places
that section on screen. When a goal
(from the `goal` extension) is active, it's shown above the plan with its token
budget.

```
╭ Goal · Plan 1/3 ─────────────────────────╮
● Goal Refactor the auth middleware
  budget 18% · 18,000/100,000 tokens

  └ ✓ Map the call sites
  └ ● Patch the middleware
  └ ○ Add tests
╰──────────────────────────────────────────╯
```

- `✓` completed (strikethrough), `●` in progress (accent), `○` pending
- Goal marker is `●` (active) or `◐` (paused)

## Commands

- `/plan-status` — show the current plan inline
- `/plan-clear` — clear the plan

## Tool

- `update_plan` — agent-facing; replace the plan (explanation + steps with
  `pending` / `in_progress` / `completed` status). Executed sequentially so the
  agent sees each update before continuing.

Box border uses the accent color from `accent-color`.
