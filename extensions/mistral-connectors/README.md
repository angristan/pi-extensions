# mistral-connectors

Exposes the connectors on your Mistral account, the same ones Mistral Vibe and
Le Chat use (Notion, Gmail, Google Drive, Slack, and others), as Pi MCP servers.

## How it works

1. The extension lists your connectors with `GET /v1/connectors/bootstrap`.
2. It registers each ready connector as an MCP server named
   `mistral_<alias>`. The server URL is
   `<base>/v1/connectors-gateway/<connector-id>/mcp`.
3. Pi's built-in MCP support connects the servers, lists their tools, and calls
   them. Requests authenticate with the API key of Pi's `mistral` provider
   through `"auth": { "provider": "mistral" }`, so the extension never stores
   the key.

Tools are named `mcp__mistral_<alias>__<tool>` and use `codemode` exposure by
default: scripts find them with `searchTools()`, and they do not add tool
schemas to the prompt. `/mcp` lists the servers with this extension as their
source.

The list is cached in `~/.pi/agent/mistral-connectors-cache.json`. On load, the
extension registers servers from the cache, so they connect with the session.
At session start, it refreshes the list in the background when the cache is
older than 10 minutes or belongs to another API key. A refresh re-registers only
servers whose configuration changed. The first failed background refresh in a Pi
process shows a warning; later failures appear only in `status`.

## Server names

Pi limits tool names to 64 characters and shortens longer
`mcp__<server>__<tool>` names with a hash suffix. Connector aliases such as
`sentry_investigation_agent_v2_read_only_42a4` hit this limit. `status` flags
these connectors; give one a short server name with
`/mistral-connectors rename <alias> <short>`, for example `sentry`, to get
`mcp__mistral_sentry__<tool>`.

## Write tools

Write tools are hidden by default. A tool counts as read-only only when the
server declares `readOnlyHint: true`; MCP treats a missing hint as "may write".
A connector whose tools declare no hints exposes nothing until you allow its
write tools, and the extension does not register it.

Tools that appear on the gateway after the last refresh stay hidden until the
next refresh classifies them.

## Choosing tools

Each tool is `on`, `ask`, or `off`. Per-tool choices take precedence over these
defaults in both directions: turn on one write tool without allowing the
others, or turn off a read-only tool. Open the searchable checklist from the
picker ("Choose tools…") or with `/mistral-connectors tools <name>`; Enter
cycles a tool through `on`, `ask`, and `off`, and Escape saves. Pi re-registers
the server once, when the checklist closes.

An override equal to the default is not saved, so allowing or hiding write
tools later still applies to every tool you did not pick.

`ask` exposes the tool but shows a confirmation with the call's arguments
before every call, including calls from codemode scripts. Declining blocks the
call and tells the model not to retry. Without an interactive UI, for example
in print mode, `ask` tools are blocked. Use it for tools that can reach private
data, such as Slack's `slack_read_channel`, which reads DMs and private
channels as well as public ones.

## Commands

| Command | Action |
|---|---|
| `/mistral-connectors` | Pick a connector to enable, disable, rename, choose its tools, or allow write tools; connect another connector; or refresh |
| `/mistral-connectors status` | List ready connectors, exposed tool counts, write access, and errors |
| `/mistral-connectors refresh` | Fetch the connector list now |
| `/mistral-connectors enable <name>` / `disable <name>` | Connect or keep a connector disconnected |
| `/mistral-connectors writes <name> on\|off` | Allow or hide its write tools |
| `/mistral-connectors tools <name>` | Open the tool checklist; outside the TUI, list tools with their state |
| `/mistral-connectors tools <name> <tool> on\|ask\|off\|reset` | Set one tool, or return it to the default |
| `/mistral-connectors rename <name> [short]` | Register it as `mistral_<short>`; without `short`, use the alias again |
| `/mistral-connectors connect <name>` | Print the sign-in URL of an OAuth connector; run `refresh` afterwards |

Disabled connectors stay registered with `enabled: false`, so `/mcp` still
lists them and can enable them for the current session. Connectors that need
credentials or other setup must be configured in Le Chat.

## Configuration

The extension uses the `mistral` provider's API key: `MISTRAL_API_KEY`, or the
`mistral` provider in `~/.pi/agent/models.json`. Commands save their changes to
`~/.pi/agent/mistral-connectors.json`:

```json
{
  "disabled": ["slack"],
  "allowWrites": ["notion"],
  "names": { "sentry_investigation_agent_v2_read_only_42a4": "sentry" },
  "tools": { "gmail": { "create_draft": true }, "linear": { "list_users": false } },
  "confirm": { "gmail": ["create_draft"], "slack": ["slack_read_channel"] },
  "exposure": "codemode",
  "baseUrl": "https://api.mistral.ai"
}
```

- `disabled`: connector aliases that do not connect.
- `allowWrites`: connector aliases whose write tools are exposed.
- `confirm`: tools by connector alias that ask before every call.
- `tools`: per-tool overrides by connector alias, then tool name: `true`
  exposes the tool and `false` hides it.
- `names`: short server names by connector alias; letters, digits, `_`, and
  `-` only.
- `exposure`: `codemode` (default), `deferred`, `direct`, or `hidden`. See
  Pi's MCP documentation for what each one does.
- `baseUrl`: Mistral API root; `/v1` suffixes are accepted.

Aliases match Mistral Vibe's connector names and are case-insensitive.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) 0.99.2 or newer, for `pi.registerMcpServer()` and provider-authenticated MCP servers, with the built-in MCP extension enabled.
- **Depends on extensions:** None.
- **Used by extensions:** None.
- **System/services:** Mistral API connectors.
