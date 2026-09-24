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
you pick:     ▌ new branch
```

Supports multiple questions in one call, "other" free-text answers, and
secret inputs. In the interactive terminal, question text and choice labels
render as Markdown, including multi-line lists and code. The dialog uses the
theme's custom-message background. Each choice has its own marker and spacing,
and the active choice has an accent rail and selection background across its
wrapped lines. The selected answer remains the original option string, not the
rendered text. Every prompt shows its position and total (`Question 2/3`) above the
question, with the same left inset as Pi's built-in dialogs. A blank row
separates the choices or input from the keyboard hints, and another follows the
hints. Non-interactive clients keep their own plain-text rendering. After an
answer, the transcript shows the same choice panel with the chosen option
highlighted and no input controls. Custom answers appear as a selected choice;
secret answers stay masked.

The terminal title becomes `❓ <session name>` while a response is pending.
When running inside Herdr, its agent-state integration receives balanced
`herdr:blocked` events, so the pane and sidebar show the question status instead
of **working** until the prompt is answered or cancelled. The status label is
generic and never contains question text.

Secret responses use a masked TUI field. The model and transcript receive only
an opaque reference such as `{{questionnaire-secret:…}}`. The model can copy
that reference unchanged into a later tool argument. Immediately before the
tool runs, Pi replaces the reference with the secret value. Known literal secret
values are replaced with `[redacted]` in final tool text and metadata.
Managed Bash also redacts command metadata and stdout/stderr before streaming,
truncating, displaying, or saving them, including secrets split across output
chunks. Commands still receive the original value.

This is not a sandbox: a command can write secrets to its own files, service
logs, or network requests. Encoded or otherwise transformed values are not
covered by literal redaction. Existing transcripts are not rewritten.
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
- **Depends on extensions:** None; `footer` keeps the pending title pinned while its activity spinner runs.
- **Used by extensions:** `telegram` and Herdr's agent-state integration, through runtime events.
