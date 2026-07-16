# auto-session-title

Generates and maintains short, descriptive titles for your pi sessions.

As soon as the first prompt is accepted, it asks a cheap model to summarize it into a 3-word title-case phrase while the main agent turn runs. After later turns settle, it re-evaluates the title from the user discussion and reuses the previous title when the topic hasn't drifted.

```
before:  untitled
after:   Compact Pi Footer
```

## Config

Defaults to Mistral Medium 3.5. Override the title-generation model via
`~/.pi/agent/auto-session-title.json` (any OpenAI-compatible provider
configured in `models.json` works):

```json
{ "provider": "mistral", "model": "mistral-medium-3.5" }
```

## Commands

- `/title-refresh` — regenerate the title now
- `/title-status` — show current title, last attempt, and skip reason
