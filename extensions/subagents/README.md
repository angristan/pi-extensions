# subagents

Run generic child agents in isolated persistent conversations while the parent
continues working.

There are no named roles or agent presets. Every spawn requires a concise name
that is unique, case-insensitively, for the parent session. Names are the public
identity for follow-ups and lifecycle actions; internal process IDs are never
displayed. Every child inherits the current model, thinking level, active tools,
working directory, and project instructions. Conversation context defaults to
`fresh`; choose `compacted` when prior decisions matter or `forked` only when the
exact active parent conversation is required. The explicit child task is the only
specialization.

## Agent tool

The extension registers one `agents` tool with nine actions. Every call also
uses the same concise `reasoning` intent field as the repository's native-style
tools.

| Action | Fields | Behavior |
|---|---|---|
| `spawn` | `task`, `name`, `context?` | Start a uniquely named child; context is `fresh` (default), `compacted`, or `forked` |
| `message` | `agent_name`, `message` | Queue context without starting an idle child turn; deliver at the next boundary if already running |
| `followup` | `agent_name`, `message` | Steer a running child or start a new turn in a hibernated child |
| `send` | `agent_name`, `message` | Legacy compatibility alias for `followup` |
| `wait` | `agent_names?`, `return_when?`, `wake_on?`, `timeout_ms?` | Wait for selected children, or every running child; wake after any update (default), final updates only, or all finals |
| `list` | — | List child status without waiting |
| `read` | `agent_name` | Return the child's latest final response without restarting it |
| `interrupt` | `agent_name` | Stop the current turn while retaining the conversation for follow-up |
| `close` | `agent_name` | Stop the child process and permanently release its context |

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
Queue a message for the test child without starting another turn.
```

## Mailbox coordination

Each child has a `report_to_parent` tool for material interim findings that can
unblock or redirect the parent. Reports publish only after that tool succeeds.
Interim reports and final results enter a bounded parent mailbox. `wait` consumes
matching updates directly and returns multiple already-queued updates together.

Updates without an active matching wait never force a model turn. While the
parent is running, new updates enter the next safe LLM request and remain present
for later requests in that run. If no further request occurs, they display when
the parent settles without starting another response. Idle updates display
immediately. Each run has one completion owner, so waited and automatic results
do not create duplicate cards.

`wait` resumes after the first selected mailbox message or completion by default.
Set `wake_on` to `final` when progress must remain queued until a final result, or
set `return_when` to `all` when every selected final result is required. Ending or
interrupting a wait never cancels children. A timeout alone is not a reason to ask
healthy running children to stop or finalize; continue independent work or wait
again. Overlapping waits on the same active child are rejected to keep event
ownership deterministic.

Interim messages are bounded by aggregate bytes and per-agent counts. Old progress
is coalesced or dropped first, omission counts are included in the next update,
and final results are never dropped. Unread final results are stored as durable
session state and recovered after reload or an unexpected runtime restart when
the same session is resumed.

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

Spawn cards show identity and prompt. Message and follow-up cards show identity
and their supplied text. Read cards show the latest result and usage. Interrupt and close cards show
identity only, avoiding repeated historical details.

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
their conversation is open. The card remains visible while children are running or mailbox updates are unread.
Its title and body show unread counts. It shows up to three detailed children and
uses an `/agents` overflow hint when space permits. The card hides
on terminals narrower than 90 columns or shorter than 10 rows. Use `/overlay`
or `Ctrl+Shift+O` to toggle the shared overlay stack.

Live child status is shown only in the overlay to avoid duplicating it in the footer.
Run `/agents` to inspect unread progress bytes and published, delivered,
consumed, coalesced, dropped, and recovered counters, or select a child to open a
scrollable live transcript that
follows new messages and tool results. Entries are grouped into labeled Task,
Agent, Thinking, Tool, and Tool result blocks instead of raw JSON. The viewer
starts at the latest entry; scroll up to pause tail-following or press End to
resume it. Inherited parent context is omitted so the transcript begins with the
delegated task.

Collapsed rows show the child name, context mode, status, prompt, and a one-line
result preview when available. Prompt always precedes result, and
completed runs always show turns, tokens, cost, and model on the final usage row.
Each billed child response also writes a durable parent-session usage record.
The footer folds those input, output, cache, and cost values directly into the
session totals, including after reload, without showing a separate child subtotal.
The parent's live context percentage remains parent-only because child contexts
are independent. Use `/agents` to inspect the full child transcript while it runs or
after it completes. Child completion messages use the same body as completed
`wait` and `list` results. Expand `wait`
or `list` results and completion messages with `Ctrl+O` to see the child's rendered output.

## Context and lifecycle

Each child is a persistent `pi --mode rpc` subprocess backed by a temporary
session:

- `fresh` (default) starts without parent conversation messages while retaining project instructions and runtime configuration.
- `compacted` generates a concise parent-conversation summary before child startup. Concurrent spawns from the same parent position reuse one summary.
- `forked` copies the active parent context with existing compaction applied.
- For `compacted` and `forked`, the unresolved assistant tool-call turn is excluded.
- The child runs in the same working directory and sees the same project files.
- Child dialogs are cancelled because no interactive UI is attached to the RPC process.
- Children can send bounded interim mailbox updates with `report_to_parent`; final responses are reported automatically.
- Settled and interrupted children hibernate: their RPC process exits while the temporary session remains available.
- Up to four queue-only messages remain pending on a hibernated child; a fifth is rejected until a follow-up delivers the queue.
- Follow-ups lazily start a new child process against the retained session and continue the same conversation.
- Concurrent `message`, `followup`, and `send` calls are dispatched one at a time per child in invocation order. A rejected dispatch cannot roll back or stop a later one; queue-only messages remain queued when the child is still idle at their turn.
- `read` retrieves the latest response without waking a hibernated child.
- `interrupt` aborts active work, hibernates the child, and preserves its session; `close` permanently removes it.
- Session shutdown and `/reload` cancel pending spawns, terminate every child process tree, and remove temporary sessions.
- A child cannot spawn grandchildren.

Up to six child conversations may remain open at once. Capacity is reserved before
asynchronous startup, so concurrent `spawn` calls cannot exceed the limit.
Settled children do not keep a process alive, but their retained sessions remain
available for reads and follow-ups and count toward the limit until `close` is
called. The parent is instructed to close a child after collecting its final result
when no further follow-up is needed. Closed child summaries remain visible for the
current parent session.

## Configuration

Optional settings are read from `~/.pi/agent/subagents.json` (or
`$PI_CODING_AGENT_DIR/subagents.json`):

```json
{
  "wait": { "minimumMs": 0, "defaultMs": 300000, "maximumMs": 3600000 },
  "mailbox": { "maxMessageBytes": 49152, "maxMessagesPerAgent": 4 }
}
```

Wait values must be ordered integers between zero and the one-hour hard maximum.
Mailbox bytes must be 8 KiB–1 MiB and per-agent messages 1–100. Invalid sections
fall back independently to defaults. Per-call `timeout_ms` must fit the resolved
minimum and maximum.

## Input and output limits

- Spawn tasks, queue-only messages, and follow-up messages are capped at 16,000 characters each.
- Interim mailbox reports are capped at 4,000 characters.
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
