# telegram

Provides Telegram communication for Pi. It exposes `notify_user` for direct
out-of-band messages and bridges delayed prompts from the `questions` extension.
Choice questions use inline buttons; free-text questions let you reply directly
to the bot. A valid Telegram answer resolves the questionnaire and dismisses the
pending Pi dialog.

## Direct messages

`notify_user` sends one Markdown-formatted message to the configured Telegram
chat. It is appropriate when:

- the user explicitly asks for a Telegram message, including a completion update;
- a time-sensitive action needs the user's awareness; or
- an important or sensitive event deserves out-of-band notice.

The tool is one-way. It must not replace `questionnaire` when the agent needs
input, confirmation, or approval. Messages may contain up to Telegram's 4,096
character limit, preserve line breaks, and disable link previews. Common
Markdown is converted to Telegram formatting: headings, bold, italic,
strikethrough, inline and fenced code, block quotes, links, lists, task lists,
and tables. Raw HTML is escaped, and unsafe link schemes remain plain text.
The agent cannot select another recipient. Calls use the same compact status
block as the other native-style tools; expand a settled call to see the complete
Markdown source.

```markdown
## Crawl complete

**42 files** are ready. Open the [report](https://example.com/report).
```

## Delayed questions

A Telegram message is sent when `questions` has been waiting for an answer for a
configurable delay (five minutes by default).

The delay applies until a questionnaire first reaches Telegram. Any remaining
questions in that same questionnaire are then sent immediately, without another
wait. Timers are cancelled when the question is answered, cancelled, the session
changes, or Pi shuts down. Secret questions remain TUI-only and produce only a
redacted passive notification.

Pending questions use a compact formatted card:

```text
❓ Input needed
my-project · Question 2 of 3

│ Which deployment target?
⏱ The agent has been waiting 5 minutes for your response.

Choose an answer below.

[ staging ]
[ production ]
```

The card uses the Pi session title as its label, falling back to the current
directory name (`pi` when running from your home directory). Dynamic text is
HTML-escaped, link previews are disabled, and option buttons stay one per row for
reliable tap targets. When the question resolves, the same
message is edited to `Answered in Telegram`, `Answered in Pi`, or `Question
cancelled in Pi`, and its controls are removed. Remote answers are shown in the
resolved card; answers entered in Pi are not copied back to Telegram.

## Setup

1. Create a bot with Telegram's [@BotFather](https://t.me/BotFather).
2. Start a chat with the bot, then obtain the destination chat ID.
3. Run `/telegram setup` in Pi.

The setup flow masks the bot token, sends a test message, and writes the config
to `$PI_CODING_AGENT_DIR/telegram-notifications.json` (defaults to
`~/.pi/agent/telegram-notifications.json`) with mode `0600`. The legacy filename
is retained so existing installations continue to work after the extension
rename.

```json
{
  "botToken": "123456:bot-token",
  "chatId": "123456789",
  "delayMinutes": 5,
  "enabled": true
}
```

The token is stored locally in this file rather than in an environment variable.
Anyone who can read the token can control the bot, so do not commit or share the
config file.

## Behavior and limitations

- Choice answers are correlated through the bot message and button index.
- Free text is accepted only when it replies to the matching bot message in the
  configured chat.
- Secret prompts never expose their question text or accept Telegram answers;
  their redacted notification updates to `Answered securely in Pi` when done.
- Answer polling uses Telegram `getUpdates`; the bot must not have a webhook.
- Pi processes under one user account on a machine coordinate through an
  owner-only runtime spool, so only one process polls a given bot token and
  answers still route to the Pi
  session whose Telegram message received the reply. If that process exits,
  another waiting process takes ownership and continues from the saved offset.
- Coordination is machine-local. Two devices using the same bot token can still
  conflict; use one bot per device or a shared cross-device receiver.

## Commands

- `/telegram setup` — securely configure the bot, chat, and delay
- `/telegram status` — show configuration status without exposing credentials
- `/telegram test` — send a test message
- `/telegram on` / `/telegram off` — enable or disable direct messages and delayed questions

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API and [Marked](https://marked.js.org/) for Markdown parsing.
- **Service:** [Telegram Bot API](https://core.telegram.org/bots/api), including
  `sendMessage`, inline keyboards, `ForceReply`, and `getUpdates`.
- **Depends on extensions:** `better-native-pi` for shared compact tool-rendering
  primitives. Optionally `questions`, through its `questions:waiting`,
  `questions:answer`, and `questions:resolved` runtime events. Direct messages
  work without `questions`.
- **Used by extensions:** None.
