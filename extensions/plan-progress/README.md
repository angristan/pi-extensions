# plan-progress

Track a multi-step plan as a collapsible overlay above the editor, and expose a
tool the agent can call to maintain it.

The agent maintains the plan via the `update_plan` tool; this extension owns the
tool logic, validation, persistence, agent guidance, and plan-section rendering.
Each update remains in its append-only tool result instead of rebuilding the
system prompt with mutable plan state, preserving prompt-prefix cache reuse. The
package's generic `overlay-stack` only supplies consistent card framing and places
that section on screen. If the `goal` extension is active, its separate card can
appear above the plan.

```
╭ Plan 1/3 ─────────────────────────────────╮
✓ Map the call sites
● Patch the middleware
○ Add tests
╰───────────────────────────────────────────╯
```

- `✓` completed (strikethrough), `●` in progress (accent), `○` pending

## Commands

- `/plan-status` — show the current plan inline
- `/plan-clear` — clear the plan

## Tool

- `update_plan` — agent-facing; replace the plan (explanation + steps with
  `pending` / `in_progress` / `completed` status). Executed sequentially so the
  agent sees each update before continuing.

Box border uses the accent color from `accent-color`.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`overlay-stack`](../overlay-stack/).
- **Used by extensions:** None.
