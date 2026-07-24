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

When the `goal` extension has an active self-driving goal, routine turn-complete
bells are suppressed. Notifications still fire for user input requests, explicit
notification events, and terminal goal states (`complete` / `blocked`). A failed
tool that later succeeds on retry is treated as recovered, so the settled run
uses the normal turn-complete notification.

## Config

`$PI_CODING_AGENT_DIR/notifications.json` (defaults to
`~/.pi/agent/notifications.json`):

```json
{ "enabled": true }
```

## Commands

- `/notifications on|off|status` — toggle or check status

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
