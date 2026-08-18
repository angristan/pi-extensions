# auto-session-title

Automatically gives Pi sessions short, descriptive titles.

The extension creates a provisional title from the first prompt, then refreshes
it after each completed turn. A rolling focus summary keeps the title aligned
with the session's main objective instead of the latest implementation detail.
Titles contain one to three words.

Manual renames pause automatic updates. Run `/title-refresh` to resume them.

## Privacy and persistence

Title generation receives a bounded view of the conversation: the current
request and outcome, the durable focus, and recent turn summaries. It never
receives reasoning, tool calls, tool output, logs, or diffs. Clipboard image
paths are redacted, and generated filesystem-path titles are rejected.

Focus and turn summaries are stored as hidden session metadata. They stay out of
the agent context and follow the active branch across reloads, resumes, forks,
and tree navigation.

## Configuration

Start Pi with `--no-auto-title` to disable automatic title generation for that
process only. `/title-refresh` remains available for a manual one-off refresh.

The default backend is Mistral Medium 3.5 with minimal thinking. Configure an
ordered model list in `~/.pi/agent/auto-session-title.json`, or under
`$PI_CODING_AGENT_DIR` when set:

```json
{
  "models": [
    {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinkingLevel": "xhigh"
    },
    {
      "provider": "apple-foundation-models",
      "model": "system",
      "thinkingLevel": "off"
    }
  ]
}
```

Models are tried in order. Missing models, unavailable authentication, request
errors, and invalid title responses advance to the next model. Pi shows a small
warning when a fallback first becomes active, then suppresses repeated warnings
while the same fallback route remains active. `/title-status` shows the selected
model and latest fallback.

The previous top-level `provider`, `model`, and `thinkingLevel` object remains
supported as a single-model configuration. `thinkingLevel` accepts `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The legacy `reasoning`
key is also accepted on each model.

### Apple on-device model

On Apple Silicon with macOS 26 or later, titles can use the system model that
powers Apple Intelligence:

```json
{
  "provider": "apple-foundation-models",
  "model": "system",
  "thinkingLevel": "off"
}
```

This backend requires Apple Intelligence and a local Swift toolchain. All title
context stays on-device. It uses deterministic generation with a strict
one-to-three-word schema. The native helper is compiled once and reused from
Pi's content-addressed cache. `thinkingLevel` does not apply to this backend.

## Commands

- `/title-refresh` — regenerate the title and resume automatic updates
- `/title-status` — show the current title, summaries, and last request status

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
