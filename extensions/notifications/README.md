# notifications

Desktop notifications for agent activity, so you can context-switch away and
get pinged when there's something to look at.

Sends a **terminal bell** (`\a`, wrapped in tmux passthrough when inside tmux)
— a portable signal each terminal decides how to surface:

- **Ghostty** — 🔔 unread-tab marker + dock bounce
- **iTerm / WezTerm / Kitty** — audible bell and/or tab marker per settings
- Plain terminals — may do nothing

Only fires when the terminal is **unfocused** (detected via focus-reporting
escape sequences on Ghostty/iTerm/Kitty/Warp/WezTerm). Deduplicates identical
notifications within a 5s window.

## Config

`~/.pi/agent/notifications.json`:

```json
{ "enabled": true }
```

## Commands

- `/notifications on|off|status` — toggle or check status
