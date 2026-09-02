# subagents

Run child agents in isolated, persistent Pi conversations while the parent keeps
working.

Each child has a unique name, an explicit task, and no preset role. It inherits
the parent model, thinking level, active tools, working directory, and project
instructions. A child cannot spawn grandchildren.

## Tool

The extension registers the `agents` tool.

| Action | Required fields | Behavior |
|---|---|---|
| `spawn` | `name`, `task` | Start a child. Optional `context`: `fresh`, `compacted`, or `forked` |
| `message` | `agent_name`, `message` | Queue context without starting an idle child turn |
| `followup` | `agent_name`, `message` | Steer a running child or resume a retained conversation |
| `send` | `agent_name`, `message` | Compatibility alias for `followup` |
| `wait` | — | Collect selected child updates without stopping other work |
| `list` | — | List child states |
| `read` | `agent_name` | Return the latest response without resuming the child |
| `interrupt` | `agent_name` | Stop the current turn and retain the conversation |
| `close` | `agent_name` | Delete the child conversation and free its slot |

Names are unique without case sensitivity. A closed name cannot be reused in the
same parent session. Up to six child conversations can remain open.

### Context modes

- `fresh` is the default. It includes project instructions but no parent messages.
- `compacted` adds a summary of the current parent conversation.
- `forked` copies the active parent conversation.

Compacted and forked context exclude the unresolved tool-call turn that spawned
the child.

### Waiting and messages

`wait` targets named children or all running children. It returns after the first
selected update by default. Use `wake_on: "final"` to ignore interim reports, or
`return_when: "all"` to wait for every selected final result. A timeout does not
stop children.

`message` stays queue-only when a child is idle. `followup` starts a new turn when
needed. Messages sent to one child are serialized in invocation order.

## UI

Running children appear in the shared top-right overlay with their task, latest
activity, and token usage.

Use `/agents` to inspect mailbox metrics or open any retained child transcript.
The read-only full-screen viewer follows live messages, renders agent responses as
Markdown, and shows the child task, state, context mode, model, and adjacent
sessions. An opaque themed surface and full-width dividers keep it distinct from
the parent transcript. It supports normal scroll keys and hides the shared status
overlay while open.

When the parent input is blank:

- Right opens the first running or paused child.
- Left and Right move through running and paused children in spawn order.
- Left from the first child returns to the parent.
- Right on the last child does nothing.

Typed input keeps normal cursor behavior. Completed, failed, and interrupted
children remain available through `/agents`, but keyboard navigation skips them.

## Results and mailbox

Children can use `report_to_parent` for material interim findings. Interim reports
and final results enter a bounded parent mailbox.

Updates do not force a parent model turn. Each automatic update is queued once as
a visible custom message at the next safe turn boundary while the parent is
running, or appended immediately when the parent is idle. Because the same
message is stored in session history and sent to the model, no model-only mailbox
context can leak into a later task. Final results are persisted until delivered or
consumed. Waited and automatic delivery do not produce duplicate completion
cards.

Mailbox cards group each child into a separate block with a status symbol, readable
task summary, Markdown-rendered result, and subdued usage metadata. Status symbols
and errors carry semantic color. The Task label uses the theme's blue heading color
and the Result label uses success green; both contents use the same softer
tool-output color. Purple stays reserved for lowercase reasoning phrases. Cards
normalize legacy Title-case reasons while preserving acronyms, omit internal
spacer rows and put the result label beside the preview. The context mode
appears in the spawn headline only, where it affects the action. Long results keep
only the first rendered row, followed immediately by an explicit truncated-row
count and the full-result shortcut.

Child model usage is persisted in the parent session and included in the footer's
token and cost totals. Parent and child context windows remain independent.

## Lifecycle

Each child runs as `pi --mode rpc` with its own session file.

- Running children hibernate after completion, interruption, or provider limits.
- Completed conversations can receive a later follow-up.
- Provider quota and rate-limit failures become `paused` and can be resumed.
- Other terminal errors become `failed`.
- `/reload`, quit, and session replacement checkpoint open children and stop their processes.
- Hard-exit cleanup uses one process-global reaper across reloads and retains callbacks only while child PIDs are live.
- Resuming the same parent session restores open children in a hibernated state.
- `close` deletes the managed child session and prevents later restoration.
- Child dialogs are cancelled because the RPC process has no direct interactive UI.

## Configuration

Optional settings live in `~/.pi/agent/subagents.json`, or under
`$PI_CODING_AGENT_DIR` when set.

```json
{
  "wait": { "minimumMs": 0, "defaultMs": 300000, "maximumMs": 3600000 },
  "mailbox": { "maxMessageBytes": 49152, "maxMessagesPerAgent": 4 }
}
```

Wait values must be ordered integers between zero and one hour. Mailbox bytes must
be 8 KiB–1 MiB. Per-agent mailbox counts must be 1–100. Invalid sections use
default values.

## Limits

- Tasks and child-bound messages: 16,000 characters
- Interim reports: 4,000 characters
- Final child result: 24 KiB
- Combined tool output: below Pi's 50 KiB limit
- RPC record: 2 MiB
- Retained stderr: 16 KiB tail
- Queue-only messages per idle child: 4
- Open child conversations: 6

Children share the parent working tree. Parallel reads are safe. Concurrent edits
must use separate file scopes.

## Dependencies

- **Runtime:** Pi extension, session, TUI, and RPC APIs
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/), [`overlay-stack`](../overlay-stack/), [`transcript`](../transcript/).
- **npm packages:** None
- **External services:** The configured model provider only
