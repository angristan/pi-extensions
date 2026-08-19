# telegram

Provides Telegram communication for Pi. It exposes `notify_user` for rare,
critical out-of-band alerts and bridges delayed prompts from the `questions`
extension. Choice questions use inline buttons; free-text questions let you
reply directly to the bot. A valid Telegram answer resolves the questionnaire
and dismisses the pending Pi dialog.

## Critical alerts

The agent can call `notify_user` after stopping further risky action when a
credible security issue, data exposure, production incident, or unintended
destructive change needs immediate attention. The tool accepts one sanitized
`message` of at most 2,000 characters. It must not be used for routine status,
completion notices, ordinary failures, or questions, and messages must not
contain credentials, secret values, private keys, or raw leaked data.

Alerts include the session title, falling back to the current directory name:

```text
🚨 Critical agent alert
api-worker

Credentials may be exposed. Work stopped.
```

Identical alerts are suppressed for five minutes. Each successful or suppressed
call remains visible in the tool transcript. The destination is always the chat
ID saved during setup; the agent cannot choose another recipient.

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
- Telegram permits only one active `getUpdates` consumer per bot. Avoid waiting
  for Telegram answers from multiple Pi processes at the same time; a conflict
  leaves the local TUI prompt usable and reports an error.

## Commands

- `/telegram setup` — securely configure the bot, chat, and delay
- `/telegram status` — show configuration status without exposing credentials
- `/telegram test` — send a test message
- `/telegram on` / `/telegram off` — enable or disable alerts and delayed questions

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Service:** [Telegram Bot API](https://core.telegram.org/bots/api), including
  `sendMessage`, inline keyboards, `ForceReply`, and `getUpdates`.
- **Depends on extensions:** Optionally `questions`, through its
  `questions:waiting`, `questions:answer`, and `questions:resolved` runtime
  events. Direct alerts work without it.
- **Used by extensions:** None.
