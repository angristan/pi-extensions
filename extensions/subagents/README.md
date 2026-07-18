# subagents

Run generic child agents in isolated persistent conversations while the parent
continues working.

There are no named roles or agent presets. Every child inherits the current
model, thinking level, active tools, working directory, project instructions,
and compaction-aware conversation context. The explicit child task is the only
specialization.

## Agent tool

The extension registers one `agents` tool with five actions:

| Action | Fields | Behavior |
|---|---|---|
| `spawn` | `task` | Start a child and immediately return its ID |
| `send` | `agent_id`, `message` | Steer a running child or continue an idle child |
| `wait` | `agent_ids?`, `timeout_ms?` | Wait for selected children, or every running child |
| `list` | — | List child status without waiting |
| `close` | `agent_id` | Stop the child process and release its context |

Multiple `spawn` calls can execute concurrently. Parallelism is therefore a
normal consequence of spawning independent tasks rather than a separate mode.

Example requests:

```text
Spawn one child to inspect the API changes and another to find missing tests.
Continue reviewing the implementation while they run.
```

```text
Send the API child a follow-up asking it to verify the upstream documentation.
```

Completed children inject a compact result into the parent conversation and
wake the parent if it is idle. Calling `wait` suppresses that automatic message
for the children being awaited, so their results appear only once.

## UI

The footer reports active children:

```text
2 subagents running · /agents
```

Use `/agents` to list children and inspect their latest result. Child completion
messages show task, status, model, turns, tokens, and cost; expand tool output
with `Ctrl+O` to see the rendered result.

## Context and lifecycle

Each child is a persistent `pi --mode rpc` subprocess backed by a temporary
session:

- The active parent context is copied with compaction already applied.
- The unresolved assistant tool-call turn is excluded from the fork.
- The child runs in the same working directory and sees the same project files.
- Child dialogs are cancelled because no interactive UI is attached to the RPC process.
- Follow-ups reuse the same child conversation.
- Session shutdown and `/reload` terminate every child and remove temporary sessions.
- A child cannot spawn grandchildren.

Up to six child processes may remain open at once. Completed children remain
available for follow-ups and count toward that limit until `close` is called.
Closed child summaries remain visible for the current parent session.

## Output limits

- One child result is capped at 24 KiB.
- Combined `wait` output is capped below Pi's 50 KiB tool-result limit.
- Child stderr is retained as a bounded tail for failures.

## Concurrency warning

Children share the same working tree. Parallel read-heavy work is safe, but
parallel edits should use disjoint file scopes to avoid conflicting writes.

## Dependencies

- **Runtime:** Pi's extension, session, and RPC APIs.
- **npm packages:** None.
- **External services:** None beyond the configured model provider.
