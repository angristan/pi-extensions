# notifications

Desktop notifications for agent activity, so you can context-switch away and
get pinged when there's something to look at.

macOS-only — uses `osascript` to post native notifications. Deduplicates
identical notifications within a 5s window, and suppresses them while the
terminal is focused (via focus-reporting escape sequences).

## Config

`~/.pi/agent/notifications.json`:

```json
{ "enabled": true }
```

## Commands

- `/notifications on|off|status` — toggle or check status
