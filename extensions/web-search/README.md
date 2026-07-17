# web-search

Provider-neutral web search, news search, and remote page opening, rendered as
compact transcript rows that match better-native-pi's tool-block grammar.

The extension keeps three stable agent-facing tools:

- `web_search` — general web search
- `news_search` — recent and date-bounded news discovery
- `open_url` — remote fallback after local retrieval fails

## Routing

Requests use sequential fallbacks. Providers are never raced, avoiding duplicate
requests and unnecessary Firecrawl credits.

```text
web_search   Exa → Mistral (when configured) → Firecrawl
news_search  Exa → Firecrawl
open_url     Exa → Firecrawl → Mistral (when configured)
PDFs         Exa → Mistral (Firecrawl disabled by default)
```

Mistral news search is disabled by default because its topical matching is not
reliable enough for technical and company news. Mistral remains useful as an
optional web fallback and for opening Mistral news article IDs.

Fallbacks happen after timeouts, rate limits, server failures, blocked pages,
empty content, or empty search results. A provider that returns HTTP 429 is
paused for one minute in the current process.

## Access

Exa and Firecrawl support anonymous access. Optional keys raise their service
limits:

- `EXA_API_KEY`
- `FIRECRAWL_API_KEY`

Mistral continues to read its API key and base URL from the `mistral` provider in
`models.json`, with `MISTRAL_API_KEY` as the environment fallback.

Optional routing overrides:

- `PI_WEB_SEARCH_PROVIDER=exa|mistral|firecrawl`
- `PI_WEB_NEWS_PROVIDER=exa|mistral|firecrawl`
- `PI_WEB_OPEN_PROVIDER=exa|mistral|firecrawl`
- `PI_WEB_SEARCH_ENABLE_MISTRAL_NEWS=1` — add Mistral as the final news fallback
- `PI_WEB_ALLOW_FIRECRAWL_PDF=1` — permit Firecrawl PDF fallback

Firecrawl charges per processed page. A long PDF can consume hundreds of
credits, so Firecrawl PDF opening is opt-in even when Firecrawl is the configured
primary opener.

Use `/web-status` to inspect effective routes, anonymous/keyed availability, and
providers temporarily paused after rate limiting. Credential values are never
shown.

## Results

Agent-facing content and human-facing display details are bounded separately.
Search output truncates only between complete records. Page output is capped at
50KB and 2,000 lines. Remote text is stripped of terminal controls, unsafe URLs
are rejected, and result URLs are normalized and deduplicated.

Provider attempts and reported credit usage are retained in bounded result
details. Fallbacks render explicitly:

```text
• Searched “auth middleware docs”
  └ 10 results · via Exa · <1s

• Opened https://example.com/docs
  └ 420 lines · 31KB · via Exa → Firecrawl · 1 credit · 1.2s
```

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/).
- **System/services:** Exa and Firecrawl; Mistral is optional.
