# telegram-notifications

Sends a Telegram message when the `questions` extension has been waiting for an
answer for a configurable delay (five minutes by default). Choice questions use
inline buttons; free-text questions let you reply directly to the bot. A valid
Telegram answer resolves the questionnaire and dismisses the pending Pi dialog.

The timer resets for each question and is cancelled when the question is
answered, cancelled, the session changes, or Pi shuts down. Secret questions
remain TUI-only and produce only a redacted passive notification.

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
to `~/.pi/agent/telegram-notifications.json` with mode `0600`.

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
- Telegram permits only one active `getUpdates` consumer per bot. Avoid waiting
  for Telegram answers from multiple Pi processes at the same time; a conflict
  leaves the local TUI prompt usable and reports an error.

## Commands

- `/telegram setup` — securely configure the bot, chat, and delay
- `/telegram status` — show configuration status without exposing credentials
- `/telegram test` — send a test message
- `/telegram on` / `/telegram off` — enable or disable notifications

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Service:** [Telegram Bot API](https://core.telegram.org/bots/api), including
  `sendMessage`, inline keyboards, `ForceReply`, and `getUpdates`.
- **Depends on extensions:** `questions`, through its `questions:waiting`,
  `questions:answer`, and `questions:resolved` runtime events.
- **Used by extensions:** None.
