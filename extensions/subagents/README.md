# subagents

Run generic child agents in isolated persistent conversations while the parent
continues working.

There are no named roles or agent presets. Every spawn requires a concise name
that is unique, case-insensitively, for the parent session. Names are the public
identity for follow-ups and lifecycle actions; internal process IDs are never
displayed. Every child inherits the current model, thinking level, active tools,
working directory, and project instructions.
By default it also inherits compaction-aware conversation context; set
`fork_context: false` for a fresh conversation containing only the explicit task.
The explicit child task is the only specialization.

## Agent tool

The extension registers one `agents` tool with five actions. Every call also
uses the same concise `reasoning` intent field as the repository's native-style
tools.

| Action | Fields | Behavior |
|---|---|---|
| `spawn` | `task`, `name`, `fork_context?` | Start a uniquely named child; context inheritance defaults to `true` |
| `send` | `agent_name`, `message` | Steer a running child or continue an idle child |
| `wait` | `agent_names?`, `timeout_ms?` | Wait for selected children, or every running child |
| `list` | — | List child status without waiting |
| `close` | `agent_name` | Stop the child process and release its context |

Multiple `spawn` calls can execute concurrently. Name reservations are atomic,
so case-insensitive duplicates fail immediately even during concurrent startup.
Names remain reserved after close for the rest of the parent session. Parallelism
is therefore a normal consequence of spawning independent tasks rather than a
separate mode.

Example requests:

```text
Spawn one child to inspect the API changes and another to find missing tests.
Continue reviewing the implementation while they run.
```

```text
Send the API child a follow-up asking it to verify the upstream documentation.
```

Completed children inject a compact result into the parent conversation and
wake the parent if it is idle. Each run has one completion owner: `wait` renders
the result when it collects the run; otherwise the automatic completion does.
A late `wait` hides its duplicate card when the automatic result was already
reported.

## UI

Calls match the shared native-tool visual language: the state bullet carries
progress, success, or error color; the verb is neutral bold text; and only the
reasoning phrase uses the theme accent. Agent names are neutral bold text, prompt
labels and metadata recede, prompt text and usage values stay dim, and the
`result` label carries success or error color while result text remains readable.
Identity and status come first, followed by prompt, result preview, and usage.
Waited and automatic completions share the exact same body.

```text
• Agent completed
  └ ✓ api review · forked context · completed
    prompt  Inspect the API changes
    result  The API is sound; one missing edge-case test was identified.
    usage   2 turns · ↑18k · ↓1.2k · R31k · $0.0842 · provider/model
```

Spawn cards show identity and prompt. Send cards show identity and the follow-up
prompt. Close cards show identity only, avoiding repeated historical details.

In TUI mode, actively running children also appear in the shared top-right
overlay stack:

```text
 Agents ● 2 running
 ● api review                      42k tok
   Inspect the API changes
   ↳ read: extensions/subagents/index.ts
 ● test audit                       31k tok
   Find missing renderer coverage
   ↳ bash: bun test extensions/subagents
```

Each active child gets three rows for identity and usage, a dedicated task
preview, and latest activity. Elapsed startup time is intentionally omitted. The
token total combines input, output, cache-read, and cache-write usage across the
persistent conversation. Completed and failed children disappear from the live
overlay as soon as they settle, but remain available through `/agents` while
their conversation is open. The card hides automatically when no children are running. It shows up to three detailed
children and uses an `/agents` overflow hint when space permits. The card hides
on terminals narrower than 90 columns or shorter than 10 rows. Use `/overlay`
or `Ctrl+Shift+O` to toggle the shared overlay stack.

The footer still reports active children:

```text
2 subagents running · /agents to view
```

Collapsed rows show the child name, context mode, status, prompt, and a one-line
result preview when available. Prompt always precedes result, and
completed runs always show turns, tokens, cost, and model on the final usage row.
Use `/agents` to list children and inspect their latest result. Child completion
messages use the same body as completed `wait` and `list` results. Expand `wait`
or `list` results and completion messages with `Ctrl+O` to see the child's rendered output.

## Context and lifecycle

Each child is a persistent `pi --mode rpc` subprocess backed by a temporary
session:

- By default, the active parent context is copied with compaction already applied.
- Set `fork_context: false` to start without parent conversation messages while retaining project instructions and runtime configuration.
- When context is inherited, the unresolved assistant tool-call turn is excluded from the fork.
- The child runs in the same working directory and sees the same project files.
- Child dialogs are cancelled because no interactive UI is attached to the RPC process.
- Follow-ups reuse the same child conversation.
- Session shutdown and `/reload` cancel pending spawns, terminate every child process tree, and remove temporary sessions.
- A child cannot spawn grandchildren.

Up to six child processes may remain open at once. Capacity is reserved before
asynchronous startup, so concurrent `spawn` calls cannot exceed the limit.
Completed children do not expire automatically: they remain available for
follow-ups and count toward that limit until `close` is called. The parent is
instructed to close a child after collecting its final result when no further
follow-up is needed. Closed child summaries remain visible for the current
parent session.

## Input and output limits

- Spawn tasks and follow-up messages are capped at 16,000 characters each.
- One child result is capped at 24 KiB.
- Combined `wait` output is capped below Pi's 50 KiB tool-result limit.
- Individual RPC records are capped at 2 MiB.
- Child stderr is retained as a bounded 16 KiB tail for failures.

## Concurrency warning

Children share the same working tree. Parallel read-heavy work is safe, but
parallel edits should use disjoint file scopes to avoid conflicting writes.

## Dependencies

- **Runtime:** Pi's extension, session, and RPC APIs.
- **npm packages:** None.
- **External services:** None beyond the configured model provider.
