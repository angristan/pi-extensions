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
web_search   Exa → Firecrawl (when configured) → Mistral (when configured)
news_search  Exa → Firecrawl (when configured) → Mistral (when configured)
open_url     Exa → Firecrawl (when configured) → Mistral (when configured)
```

The same default provider order is used for web search, news search, and URL
opening. Mistral article IDs are still opened with Mistral directly when
configured.

Fallbacks happen after timeouts, rate limits, server failures, blocked pages,
empty content, or empty search results. A provider that returns HTTP 429 is
paused for one minute in the current process.

## Access

Exa supports anonymous access, with `EXA_API_KEY` available for higher service
limits. Firecrawl is credential-gated to avoid flaky shared-IP keyless limits;
set `FIRECRAWL_API_KEY` before it appears in routes.

Mistral continues to read its API key and base URL from the `mistral` provider in
`models.json`, with `MISTRAL_API_KEY` as the environment fallback. Without a
resolvable key, Mistral is omitted from every route.

Optional routing overrides:

- `PI_WEB_SEARCH_PROVIDER=exa|mistral|firecrawl`
- `PI_WEB_NEWS_PROVIDER=exa|mistral|firecrawl`
- `PI_WEB_OPEN_PROVIDER=exa|mistral|firecrawl`

Each tool also accepts an optional `provider` argument (`exa`, `firecrawl`, or
`mistral`) to try that provider first for a single call. Per-call preferences
win over environment overrides, but unavailable providers are skipped and the
normal fallback route continues.

Use `/web-status` to inspect effective routes, keyed availability, and providers
temporarily paused after rate limiting. Credential values are never shown.

## Fetch policy

After search discovery, use local `ax` for readable page fetches. Use `curl` for
protocol-level HTTP diagnostics such as headers, redirects, TLS, auth,
robots/sitemaps, or API reproduction. Use `open_url` only as a remote fallback
when local content retrieval is unavailable, blocked, or produces poor content.

## Results

Agent-facing content and human-facing display details are bounded separately.
Search output truncates only between complete records. Page output is capped at
50KB and 2,000 lines. Remote text is stripped of terminal controls, unsafe URLs
are rejected, and result URLs are normalized and deduplicated.

Provider attempts and reported credit usage are retained in bounded result
details. Search headlines accent the query inside dim quotation marks. Result
rows show clickable full URLs in normal text plus muted source and date metadata;
titles and snippets remain agent-facing without adding visual noise to the
transcript. Sanitized failure messages wrap to the transcript width instead of
being ellipsized, so the bounded provider reason remains visible in full.
Fallbacks render explicitly:

```text
• Searched “auth middleware docs”
  └ 10 results · via Exa · <1s
    1. https://example.com/docs · 2026-04-21

• Opened https://example.com/docs
  └ 420 lines · 31KB · via Exa → Firecrawl · 1 credit · 1.2s
```

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/).
- **System/services:** Exa; Firecrawl and Mistral are optional keyed providers.
