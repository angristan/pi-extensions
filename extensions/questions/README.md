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
secret inputs. Secret responses use a masked TUI field; only a
`[secret provided]` marker is sent to the model or persisted in the transcript.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
