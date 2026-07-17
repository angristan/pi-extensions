# mistral-web-search

Web search via Mistral's web-search connector, rendered as compact transcript
rows that match better-native-pi's tool-block grammar.

Exposes three agent-facing tools that call Mistral's web-search MCP:

- `web_search` — keyword web search
- `news_search` — news article search (date-bounded)
- `open_url` — fallback opener for a URL / article ID when local retrieval with tools like `ax` fails

Results render as tree-structured rows:

```
• Searched “auth middleware docs”
  └ 20 results · via Brave · <1s
    1. RFC 9449 — OAuth 2.0 Pushed Authorization — datatracker.ietf.org · 2024
       Defines the pushed authorization request endpoint and request flow…
    2. Middleware patterns in web frameworks — owasp.org · 2023
       Security guidance for authentication and authorization middleware…
    5 shown · 15 more
```

Agent-facing content and human-facing display details are bounded separately.
Agent output omits descriptions and deduplicates normalized snippets; bounded
descriptions remain available only as a renderer fallback when no snippet exists.
Search output truncates only between complete result records, while the compact
renderer keeps clickable titles, website/search-engine/date metadata, and one
clean evidence line. Shared search-engine attribution appears once in the
summary; mixed engines remain labeled per result. Remote text is stripped of
terminal control sequences, hyperlinks accept only normalized HTTP(S) URLs,
connector timeouts render as `Open failed`, and JavaScript/CAPTCHA challenge
pages render as `Open blocked`.

## Config

Reads provider config (API key, base URL) from your `models.json` Mistral
provider entry. Tools auto-enable/disable based on the active model.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/).
- **Used by extensions:** None.
- **System/service:** A configured Mistral provider for remote search requests.
