# questions

A tool the agent can call to ask you structured questions and preserve the
answers in the transcript.

Instead of free-text asking and parsing your reply, the agent calls
`questionnaire` with one or more questions (each with optional choices,
allow-other, and secret). You get a proper picker/input; the answer is recorded
as a structured entry so it survives compaction.

```
agent calls: questionnaire({ questions: [{
  id: "branch", question: "Work on main or a new branch?",
  options: ["main", "new branch"]
}] })
you pick:     ▶ new branch
```

Supports multiple questions in one call, "other" free-text answers, and
secret inputs. Every prompt shows its position and total (`Question 2/3`) with
accented progress, a subdued separator, and readable theme-text question copy.
The terminal title switches to `❓ Input needed` while a response is pending.
Secret responses use a masked TUI field; only a `[secret provided]` marker is
sent to the model or persisted in the transcript.

Each prompt emits `questions:waiting` with an opaque request ID, response mode,
options, progress, and whether the response is secret. Trusted integrations can
submit a matching `questions:answer`; a valid remote answer dismisses the local
dialog and is recorded exactly like a TUI answer. `questions:resolved` reports
whether the prompt was answered or cancelled and whether TUI or remote input won.
Remote answers are rejected for secret
questions, and `telegram-notifications` redacts secret question text before it
leaves Pi.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None; `footer` optionally keeps the attention title pinned while its activity spinner runs.
- **Used by extensions:** `telegram-notifications`, through runtime events.
