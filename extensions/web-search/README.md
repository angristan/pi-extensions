# web-search

Provider-neutral web search and remote page opening, rendered as
compact transcript rows that match better-native-pi's tool-block grammar.

The extension keeps two stable agent-facing tools:

- `web_search` — general and date-bounded web search
- `open_url` — remote fallback after local retrieval fails

## Routing

Requests use sequential fallbacks. Providers are never raced, avoiding duplicate
requests and unnecessary Firecrawl credits.

```text
web_search  Exa → TinyFish (when configured) → Firecrawl (when configured) → Mistral (when configured)
open_url    Exa → TinyFish (when configured) → Firecrawl (when configured) → Mistral (when configured)
```

The same default provider order is used for web search and URL opening.
Mistral article IDs are still opened with Mistral directly when configured.

Unfiltered queries use Exa's basic search. Supplying publication dates, a
category, domain filters, or `maxAgeHours` automatically selects Exa advanced
search. The public `web_search` schema supports:

- inclusive `startDate` and `endDate` bounds
- `news`, `pdf`, `publication`, `company`, `people`, `personal site`, and
  `financial report` categories
- `includeDomains` and `excludeDomains`, including domain/path prefixes
- `maxAgeHours` (`0` for live crawl, `-1` for cache only)

GitHub is intentionally not a category: use the authenticated `gh` CLI for
anything on GitHub. Exa applies supported filters natively. Its `publication`
vertical rejects domain filters, so explicit domains take priority and the
publication intent moves into the semantic query. Its dedicated `company` and
`people` indices reject domain and publication-date filters, so those filters
are enforced locally instead. Domain and known-date constraints are enforced
again after every provider response, including fallbacks; category and
freshness controls are best effort outside Exa.

Fallbacks happen after timeouts, rate limits, server failures, blocked pages,
empty content, or empty search results. Exa has up to six HTTP 429 retry slots,
using `Retry-After` when available or exponential delays of roughly 1, 2, 4, 8,
16, and 32 seconds with jitter. The complete Exa attempt has a 30-second budget.
A delay beyond the remaining budget falls back immediately to the next provider.
Future calls try Exa again without a cross-request cooldown.

## Access

Exa uses anonymous access first. When `EXA_API_KEY` is configured, quota,
authorization, or rate-limit responses from anonymous Exa retry once with the
paid key. The key is sent in the `x-api-key` request header and never placed in
the MCP URL. HTTP 429 responses from paid Exa use the normal retry policy. If
both Exa tiers are unavailable, routing continues to the next provider.
Anonymous retries are independent in each process, so jitter reduces collisions
between concurrent sessions without shared state.

TinyFish Search and Fetch are free but require an account key. Set
`TINYFISH_API_KEY` to enable them. Search uses TinyFish's native date, domain,
news, and research-paper filters where they match the public tool contract;
unsupported categories and cache-age controls remain best effort. Firecrawl is
credential-gated to avoid flaky shared-IP keyless limits; set
`FIRECRAWL_API_KEY` before it appears in routes.

Mistral continues to read its API key and base URL from the `mistral` provider in
`$PI_CODING_AGENT_DIR/models.json` (defaults to `~/.pi/agent/models.json`), with
`MISTRAL_API_KEY` as the environment fallback. Without a
resolvable key, Mistral is omitted from every route.

Optional routing overrides:

- `PI_WEB_SEARCH_PROVIDER=exa|tinyfish|firecrawl|mistral`
- `PI_WEB_OPEN_PROVIDER=exa|tinyfish|firecrawl|mistral`

Each tool also accepts an optional `provider` argument (`exa`, `tinyfish`,
`firecrawl`, or `mistral`) to try that provider first for a single call. Per-call
preferences win over environment overrides, but unavailable providers are
skipped and the normal fallback route continues.

Use `/web-status` to inspect effective routes and keyed availability.
Credential values are never shown.

## Fetch policy

Stop when search highlights provide enough evidence. Open only sources needed to
close a specific evidence gap. For HTML, use targeted local `ax` extraction for
specific facts or bounded Markdown for broad reading. Use `curl` for
protocol-level HTTP diagnostics such as
headers, redirects, TLS, auth, robots/sitemaps, or API reproduction. Use
`open_url` for public remote PDFs and Mistral article IDs, or as a remote HTML
fallback when local extraction is unavailable, blocked, empty, or poor. Do not
batch `open_url` as the initial HTML fetch.

## Results

Agent-facing content and human-facing display details are bounded separately.
Basic and advanced Exa searches return source highlights. Advanced full text is
bounded in transit and discarded before model context; summaries and subpages
are not requested. Search output truncates only between complete records. Page
output is capped at 50KB and 2,000 lines. Remote text is stripped of terminal
controls, unsafe URLs are rejected, and result URLs are normalized and
deduplicated.

Provider attempts and reported credit usage are retained in bounded result
details. Search headlines show only the query; filters, the actual provider
route, credits, and elapsed time stay in the summary row. Each result shows its
title followed by a clickable full URL, while snippets remain agent-facing. If
a provider returns the URL itself as the title, the numbered result shows that
clickable URL once instead of repeating it on a second row. Collapsed result
lists end with a configured expand-key hint instead of a second numeric count.
Expanded results add a per-result provider only when it differs from the
summary, the date, and up to three bounded source highlights. Sanitized
failure messages wrap to the
transcript width instead of being ellipsized, so the bounded provider reason
remains visible in full.
Fallbacks render explicitly:

```text
• Searched “Common Crawl criticism”
  └ 10 results · publication · arxiv.org + aclanthology.org · ≤24h old · via Exa · 3s
    1. Documenting Large Webtext Corpora · 2021-11-01
       https://aclanthology.org/2021.emnlp-main.98/
    … 5 more · Ctrl+O to expand

• Opened https://example.com/docs
  └ 420 lines · 31KB · via Exa → Firecrawl · 1 credit · 1.2s
```

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`better-native-pi`](../better-native-pi/).
- **System/services:** Exa; TinyFish, Firecrawl, and Mistral are optional keyed providers.
