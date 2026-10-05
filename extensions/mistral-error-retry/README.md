# mistral-error-retry

Auto-retries Mistral turns that fail with:

```text
Error: Provider stopped with: error
```

Pi's Mistral adapter shows this when the stream ends with
`finish_reason: "error"`: the model server aborted generation without giving a
reason. Retrying usually works, but Pi's auto-retry does not recognize the
wording, so the turn stops.

The extension rewrites that exact error to
`Provider stopped with: error (server error)` when the message ends. Pi's
built-in auto-retry then handles the turn with its usual backoff, status rows,
and cancel key. Other errors, such as `content_filter` or `length`, still fail
immediately.

The extension marks at most 3 consecutive failures as retryable. This stops an
endpoint that always fails from using the whole `retry.maxRetries` budget. A
successful response or a new prompt resets the count.

## Configuration

No configuration is required. Pi's auto-retry must be enabled (`retry.enabled`,
on by default). Pi's `retry.maxRetries` and backoff settings still apply.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** None.
