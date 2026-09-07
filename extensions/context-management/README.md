# context-management

Opt-in, per-session context rollover without an LLM-generated conversation summary.
The complete Pi session transcript remains on disk and visible in the TUI, while
model requests after a rollover contain only a small handoff message and newer
conversation entries.

## Usage

Context management is disabled in new sessions.

```text
/context-management on
/context-management off
/context-management status
/context-management reset
```

The setting is stored in the session's append-only history. Resumed sessions and
branches restore the latest setting on their active branch. Disabling the mode
stops future reminders and rollovers; it does not undo a rollover that already
removed older messages from the model-visible context.

When enabled, the footer status area shows `ctx:auto` and these tools become
available:

| Tool | Purpose |
|---|---|
| `context_notes` | List, read, replace, or delete durable keyed notes |
| `context_history` | Search the complete active session branch, including messages hidden by rollover |
| `get_context_remaining` | Report Pi's current context usage estimate |
| `new_context` | Start a fresh model context without summarizing the earlier transcript |

The normal working budget is 90% of the model context window. The extension sends
one hidden reminder when 6,144 tokens remain in that budget. If an active tool
chain exhausts the budget, it reserves up to 16,384 additional tokens only for a
durable `context_notes` checkpoint and `new_context`; unrelated tool calls are
blocked. A completed response is never interrupted: rollover waits for the next
idle user input. Only exhaustion of the emergency buffer aborts active work.

Each rollover adds a visible reset divider and a real Pi compaction boundary with
a fixed handoff message. No LLM-generated conversation summary is created. This
also resets the footer's context percentage immediately; the first response in
the new window replaces that provisional zero with provider-reported usage.
Native threshold compaction is cancelled while the emergency checkpoint runs.
Manual `/compact` and overflow recovery retain Pi's native behavior when no
rollover is pending.

A rollover preserves:

- Pi's system prompt, project instructions, skills, and active tools
- append-only session history and inactive branches
- durable `context_notes`
- messages created after the rollover handoff

It excludes earlier conversation messages from subsequent provider requests.
The model can recover selected details with `context_history`, but reliable
continuation still depends on it writing useful notes before rollover.

## Limitations

- Usage is based on Pi's provider-backed estimate and can be temporarily unknown.
- Turning the mode on does not immediately reset context; use
  `/context-management reset` when an immediate rollover is wanted.
- The feature does not train or modify the selected model. It only supplies the
  tools, reminders, and context boundaries needed for context-aware behavior.
- Older transcript content remains in the session file and is not a secrecy or
  deletion boundary.

## Dependencies

- **Runtime:** Pi extension APIs only.
- **Depends on extensions:** `better-native-pi` for shared compact tool rendering.
- **External services:** None.
