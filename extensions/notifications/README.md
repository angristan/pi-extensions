# notifications

Desktop notifications for agent activity, so you can context-switch away and
get pinged when there's something to look at.

Two backends, tried in order:
1. **OSC 9** (`\x1b]9;...\x07`) for terminals that render it natively —
   Ghostty, iTerm, Kitty, Warp, WezTerm. These show a native notification and
   the 🔔 unread-tab marker.
2. **Terminal bell** (`\a`, wrapped in tmux passthrough when inside tmux) as a
   portable fallback — lets the terminal/OS decide how to surface it.

Deduplicates identical notifications within a 5s window, and suppresses them
while the terminal is focused (via focus-reporting escape sequences).

## Config

`~/.pi/agent/notifications.json`:

```json
{ "enabled": true }
```

## Commands

- `/notifications on|off|status` — toggle or check status
