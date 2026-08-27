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
The terminal title stays on the session name while a response is pending.
When running inside Herdr, its agent-state integration receives balanced
`herdr:blocked` events, so the pane and sidebar show the question status instead
of **working** until the prompt is answered or cancelled. The status label is
generic and never contains question text.

Secret responses use a masked TUI field. The model and transcript receive only
an opaque reference such as `{{questionnaire-secret:…}}`. The model can copy
that reference unchanged into a later tool argument. Immediately before the
tool runs, Pi replaces the reference with the secret value. The value stays in
extension memory and is never sent to the model or persisted in the transcript.
References expire when the session changes, Pi reloads, or Pi shuts down. An
expired reference blocks the tool call and asks the model to request the secret
again.

Each prompt emits `questions:waiting` with opaque request and questionnaire IDs,
response mode, options, progress, and whether the response is secret. Trusted integrations can
submit a matching `questions:answer`; a valid remote answer dismisses the local
dialog and is recorded exactly like a TUI answer. `questions:resolved` reports
whether the prompt was answered or cancelled and whether TUI or remote input won.
Remote answers are rejected for secret
questions, and `telegram` redacts secret question text before it
leaves Pi.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** `telegram` and Herdr's agent-state integration, through runtime events.
