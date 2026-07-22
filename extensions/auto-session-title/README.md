# auto-session-title

Generates and maintains short, descriptive titles for your pi sessions.

As soon as the first prompt is accepted, it asks a cheap model for a provisional
3-word title while the main agent turn runs. After each completed turn, one
bounded request summarizes the user intent and final assistant outcome, updates
a rolling focus summary, and refreshes the title. Sustained recent work can
narrow a broad earlier title, while brief asides keep the existing title.

```
before:  untitled
after:   Compact Pi Footer
```

## Context and persistence

The title request never receives reasoning, tool calls, tool results, logs, or
raw diffs. Its 8,000-character context budget contains:

- current user request: up to 2,000 characters
- final assistant outcome: up to 2,000 characters
- rolling focus summary: up to 600 characters
- latest 8 turn summaries: up to 300 characters each
- legacy bootstrap only: 2 prior turn pairs, up to 700 characters per message

The same model call returns the turn summary, focus summary, and title. Completed
summary state is stored as hidden session metadata, stays out of agent context,
and is restored from the active branch after reloads, resumes, forks, and tree
navigation. Existing sessions without compatible summary state bootstrap from
their latest 3 completed turns: the latest turn uses the normal current-turn
budget, while the prior 2 are bounded migration context. This provides enough
history to identify a brief aside without letting old umbrella topics dominate.

## Config

Defaults to Mistral Medium 3.5. Override the title-generation model via
`~/.pi/agent/auto-session-title.json`. Any model available through Pi works,
including OAuth-backed providers such as OpenAI Codex:

```json
{ "provider": "openai-codex", "model": "gpt-5.6-luna" }
```

## Commands

- `/title-refresh` — regenerate the title now
- `/title-status` — show current title, summaries, last attempt, and skip reason

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
