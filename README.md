# pi-extensions

A collection of [pi](https://github.com/earendil-works/pi-coding-agent) TUI
extensions: nicer tool-block rendering, context telemetry, goal/plan tracking,
background jobs, working timers, and quality-of-life features for the terminal UI.

These are generic extensions with no third-party npm dependencies. They ship
together because a few share rendering helpers and runtime services, as shown
above.

## Install

```bash
pi install git:github.com/angristan/pi-extensions
```

Pi clones it to `~/.pi/agent/git/github.com/angristan/pi-extensions/` and
auto-loads every extension under `extensions/*/index.ts`. Reload with `/reload`
in a running session, or restart pi. Update later with `pi update --extensions`.

### Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) installed
- No npm dependencies — everything resolves against pi's bundled packages
  (`typebox`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`)

## Extensions

### UI & rendering

| Extension | What it does |
|---|---|
| [`accent-color`](extensions/accent-color/) | Pins the editor (input bar) border to a fixed accent color, overriding pi's default |
| [`better-native-pi`](extensions/better-native-pi/) | Restyles pi's native tools into compact, reason-first 2-line transcript blocks with shell highlighting and inline diffs |
| [`code-blocks`](extensions/code-blocks/) | Renders fenced code blocks as bordered, syntax-highlighted boxes instead of plain text |
| [`footer`](extensions/footer/) | A status line below the transcript showing session, model, context usage, and cost |
| [`hyperlinks`](extensions/hyperlinks/) | Render local file paths as clickable OSC 8 terminal hyperlinks, and expose the helper to other extensions |
| [`overlay-stack`](extensions/overlay-stack/) | Composes independent top-right overlay cards and toggles them with `Ctrl+Shift+O` or `/overlay` |
| [`petit-chat-input-bar`](extensions/petit-chat-input-bar/) | A tiny static companion sprite above the editor (a la Vibe's petit chat) |
| [`turn-separator`](extensions/turn-separator/) | Dim full-width rule between assistant messages that follow tool work, labeling long steps |
| [`turn-stats`](extensions/turn-stats/) | Per-turn timing and token-usage entries appended to the transcript after each settled response |
| [`working-timer`](extensions/working-timer/) | Adds a live elapsed timer to pi's built-in `Working...` row for long-running turns |

### Session & navigation

| Extension | What it does |
|---|---|
| [`auto-compact-continue`](extensions/auto-compact-continue/) | Automatically continues the agent after pi triggers threshold-based context compaction |
| [`auto-session-title`](extensions/auto-session-title/) | Generates and maintains short, descriptive titles for your pi sessions |
| [`history-search`](extensions/history-search/) | Incremental search across your previous user prompts, inline in the editor |
| [`rewind`](extensions/rewind/) | Fork from an earlier user prompt and restore it to the editor (`/undo` is an alias) |
| [`session-search`](extensions/session-search/) | Full-text search across all your saved sessions, with ranked results |
| [`transcript`](extensions/transcript/) | Open a full, scrollable view of the entire session transcript |

### Workflow & context

| Extension | What it does |
|---|---|
| [`context-inspector`](extensions/context-inspector/) | Inspect where your context window is being spent |
| [`edit-summary`](extensions/edit-summary/) | Show a passive overlay with net file changes for the current or last agent turn |
| [`goal`](extensions/goal/) | Track an explicit objective for the session |
| [`plan-progress`](extensions/plan-progress/) | Track a multi-step plan as a collapsible overlay above the editor, and expose a tool the agent can call to maintain it |
| [`questions`](extensions/questions/) | A tool the agent can call to ask you structured questions and preserve the answers in the transcript |
| [`side-chat`](extensions/side-chat/) | An ephemeral, read-only side question about the current conversation, without changing the main transcript |

### Tools & integrations

| Extension | What it does |
|---|---|
| [`background-jobs`](extensions/background-jobs/) | Run long-lived shell commands in the background with live status, without blocking the agent transcript |
| [`notifications`](extensions/notifications/) | Desktop notifications for agent activity, so you can context-switch away and get pinged |
| [`openai-codex-fast`](extensions/openai-codex-fast/) | Toggle OpenAI Codex Fast mode and show a purple `fast` footer indicator when active |
| [`wakatime`](extensions/wakatime/) | Tracks read and file-edit activity through an existing `wakatime-cli` installation |
| [`web-search`](extensions/web-search/) | Quality-routed web search, news discovery, and page opening through Exa, Firecrawl, and optional Mistral |

### Diagnostics & performance

| Extension | What it does |
|---|---|
| [`cached-line-resets`](extensions/cached-line-resets/) | Caches pi's per-line ANSI reset application so rendering large transcript regions stays fast |
| [`doctor`](extensions/doctor/) | Run diagnostics on your pi setup |

Each extension has its own `README.md` with commands, config, and sample output.

## Custom keybindings

| Key | Extension | Action |
|---|---|---|
| `Ctrl+R` | [`history-search`](extensions/history-search/) | Start reverse search across previous prompts; press again or use `↑` to cycle backward |
| `Ctrl+Shift+O` | [`overlay-stack`](extensions/overlay-stack/) | Hide or show the top-right overlay stack |
| `Ctrl+Shift+T` | [`transcript`](extensions/transcript/) | Open the full scrollable session transcript |

While history search is active, use `Ctrl+S` / `↓` to cycle forward, `Enter` to
accept, `Esc` / `Ctrl+C` to cancel, and `Ctrl+U` to clear the query.

## Configuration

A few extensions read optional config from `~/.pi/agent/<name>.json`:

- `auto-session-title.json` — `{"provider": "mistral", "model": "mistral-medium-3.5"}`
- `accent-color.json` — `{"color": "#FF8205"}` (accepts `#RRGGBB` / `#RGB`)
- `notifications.json` — `{"enabled": true}`
- `openai-codex-fast.json` — `{"enabled": true}`

All default to sensible values if the file is absent.

## License

MIT

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent).
- **npm packages:** None; extensions use Pi's bundled modules and Node/Bun APIs.
- **System/services:** Only where noted in each extension README.

An arrow means the extension on the left directly imports the extension on the
right. Extensions not shown have no internal extension dependency.

```text
background-jobs <------> better-native-pi ------> code-blocks
                           |
                           +---------------------> hyperlinks
web-search --------------> better-native-pi
doctor ------------------> accent-color
overlay-stack -----------> accent-color
edit-summary ------------> overlay-stack <------- plan-progress
```

`background-jobs` and `better-native-pi` deliberately integrate in both
directions: the former reuses shared rendering primitives, while the latter
owns `bash` and delegates its execution to the managed terminal service.
