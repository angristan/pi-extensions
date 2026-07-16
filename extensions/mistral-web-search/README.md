# mistral-web-search

Web search via Mistral's web-search connector, rendered as compact transcript
rows that match better-native-pi's tool-block grammar.

Exposes three agent-facing tools that call Mistral's web-search MCP:

- `web_search` — keyword web search
- `news_search` — news article search (date-bounded)
- `open_url` — fallback opener for a URL / article ID when local retrieval fails

Results render as tree-structured rows:

```
• Searched "auth middleware docs"
  └ 3 results · done
    1. RFC 9449 — OAuth 2.0 Pushed Authorization (datatracker.ietf.org · 2024 · rank 1)
    2. Middleware patterns in web frameworks (owasp.org · 2023 · rank 2)
    3. Express middleware guide (expressjs.com · rank 3)
```

## Config

Reads provider config (API key, base URL) from your `models.json` Mistral
provider entry. Tools auto-enable/disable based on the active model.

## Depends on

Reuses `better-native-pi`'s `fitToolLine` / `formatElapsed` and palette so
search rows are visually identical to the built-in tool blocks.
