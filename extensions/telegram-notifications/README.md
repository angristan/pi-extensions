# telegram-notifications

Sends a Telegram message when the `questions` extension has been waiting for an
answer for a configurable delay (five minutes by default). The timer resets for
each question and is cancelled when the question is answered, cancelled, the
session changes, or Pi shuts down.

Example message:

```text
❓ my-project: input needed
The agent has been waiting 5 minutes for your answer.
Question 2/3: Which deployment target?
```

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

## Commands

- `/telegram setup` — securely configure the bot, chat, and delay
- `/telegram status` — show configuration status without exposing credentials
- `/telegram test` — send a test message
- `/telegram on` / `/telegram off` — enable or disable notifications

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Service:** [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).
- **Depends on extensions:** `questions`, through its `questions:waiting` and
  `questions:resolved` runtime events.
- **Used by extensions:** None.
