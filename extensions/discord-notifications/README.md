# discord-notifications

Sends a Discord message when the `questions` extension has been waiting for an
answer for a configurable delay (five minutes by default). Choice questions use
message buttons; free-text questions open a small modal you fill in directly in
Discord. A valid Discord answer resolves the questionnaire and dismisses the
pending Pi dialog.

The delay applies until a questionnaire first reaches Discord. Any remaining
questions in that same questionnaire are then sent immediately, without another
wait. Timers are cancelled when the question is answered, cancelled, the session
changes, or Pi shuts down. Secret questions remain TUI-only and produce only a
redacted passive notification.

Pending questions use a compact embed card:

```text
❓ Input needed
my-project · Question 2 of 3

> Which deployment target?
⏱ The agent has been waiting 5 minutes for your response.

Choose an answer below.

[ staging ] [ production ]
```

The card uses the Pi session title as its label, falling back to the current
directory name (`pi` when running from your home directory). Dynamic text is
escaped so it cannot break out of the embed, mention spam is disabled with
`allowed_mentions`, and option buttons are labeled with their full text. When
the question resolves, the same message is edited to `Answered in Discord`,
`Answered in Pi`, or `Question cancelled in Pi`, and its buttons are removed.
Remote answers are shown in the resolved card; answers entered in Pi are not
copied back to Discord.

## Setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications),
   then add a bot user under **Bot** and copy its token.
2. Invite the bot to a server (OAuth2 URL generator, `bot` scope) and grant it
   permission to view the channel and send messages.
3. Enable **Developer Mode** in Discord settings, right-click the destination
   channel, and copy its ID.
4. Run `/discord setup` in Pi.

The setup flow masks the bot token, sends a test message, and writes the config
to `$PI_CODING_AGENT_DIR/discord-notifications.json` (defaults to
`~/.pi/agent/discord-notifications.json`) with mode `0600`.

```json
{
  "botToken": "discord-bot-token",
  "channelId": "123456789012345678",
  "delayMinutes": 5,
  "enabled": true
}
```

The token is stored locally in this file rather than in an environment variable.
Anyone who can read the token can control the bot, so do not commit or share the
config file.

## Behavior and limitations

- Choice answers are correlated through the bot message and button custom ID.
- Free text is collected through a modal opened from the message's **Reply**
  button; only submissions tied to that message are accepted.
- Secret prompts never expose their question text or accept Discord answers;
  their redacted notification updates to `Answered securely in Pi` when done.
- Answer reception uses Discord's Gateway WebSocket; the bot must be running on
  this machine for the notification to be answerable. Unlike Telegram's single
  `getUpdates` consumer, Discord tolerates multiple gateway sessions, so
  multiple Pi processes can wait for answers concurrently.
- Discord limits a message to five action rows of five buttons each. Option sets
  larger than that fall back to a free-text reply.
- Buttons and the modal rely on the message staying attached to the channel;
  deleting the message in Discord loses the ability to answer.

## Commands

- `/discord setup` — securely configure the bot, channel, and delay
- `/discord status` — show configuration status without exposing credentials
- `/discord test` — send a test message
- `/discord on` / `/discord off` — enable or disable notifications

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Service:** [Discord API](https://discord.com/developers/docs/reference),
  including the REST endpoints for messages, message edits, and interaction
  callbacks, plus the Gateway WebSocket for `INTERACTION_CREATE` events.
- **Depends on extensions:** `questions`, through its `questions:waiting`,
  `questions:answer`, and `questions:resolved` runtime events.
- **Used by extensions:** None.
