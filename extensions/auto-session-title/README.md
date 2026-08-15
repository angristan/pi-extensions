# auto-session-title

Generates and maintains short, descriptive titles for your pi sessions.

As soon as the first prompt is accepted, it asks a cheap model for a provisional
3-word title while the main agent turn runs. After each completed turn, one
bounded request summarizes the user intent and final assistant outcome, updates
a durable session-level focus summary, and refreshes the title. Component-level
discussions stay under the main project title, even across several turns. The
title changes only when the session establishes a different primary objective.

```
before:  untitled
after:   Compact Pi Footer
```

## Context and persistence

The title request never receives reasoning, tool calls, tool results, logs, or
raw diffs. Pi clipboard image temp paths are redacted before title generation,
and generated filesystem-path titles are ignored. Its 8,000-character context
budget contains:

- current user request: up to 2,000 characters
- final assistant outcome: up to 2,000 characters
- original session focus anchor: up to 600 characters
- latest durable focus summary: up to 600 characters
- latest 8 turn summaries: up to 300 characters each
- legacy bootstrap only: 2 prior turn pairs, up to 700 characters per message

The same model call returns the turn summary, focus summary, and title. Completed
summary state is stored as hidden session metadata, stays out of agent context,
and is restored from the active branch after reloads, resumes, forks, and tree
navigation. The first completed focus is retained as an anchor so later questions
about protocols, tools, or architecture components do not replace the session's
main subject. Existing sessions without compatible summary state bootstrap from
their latest 3 completed turns: the latest turn uses the normal current-turn
budget, while the prior 2 are bounded migration context.

## Config

Defaults to Mistral Medium 3.5 with minimal thinking. Override the
title-generation model and thinking level via
`$PI_CODING_AGENT_DIR/auto-session-title.json` (defaults to
`~/.pi/agent/auto-session-title.json`). Any model available through Pi works,
including OAuth-backed providers such as OpenAI Codex:

```json
{ "provider": "openai-codex", "model": "gpt-5.6-luna", "thinkingLevel": "xhigh" }
```

`thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`. The legacy `reasoning` key is also accepted.

On Apple Silicon Macs running macOS 26 or later, the extension can use Apple's
on-device system language model:

```json
{ "provider": "apple-foundation-models", "model": "system", "thinkingLevel": "off" }
```

This backend requires Apple Intelligence to be enabled. It invokes the native
Foundation Models framework locally, sends no title context to a remote model,
and ignores `thinkingLevel`. Generation uses greedy sampling, a 256-token output
cap, and a schema constraint that guarantees one-to-three-word titles. The first
request compiles the native helper into Pi's content-addressed cache; later
requests reuse that binary.

## Commands

- `/title-refresh` — regenerate the title now
- `/title-status` — show current title, summaries, last attempt, and skip reason

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
