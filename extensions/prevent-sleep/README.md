# prevent-sleep

Keeps a Mac awake while Pi is actively processing an agent run. The idle-sleep
assertion starts on the first `agent_start` and remains active across retries,
automatic compaction recovery, and queued continuations. It is released when the
agent settles or the session shuts down.

The extension uses macOS's built-in:

```text
/usr/bin/caffeinate -i -w <pi-pid>
```

`-i` prevents idle **system** sleep. It does not prevent the display from
sleeping. `-w` also ties the helper to the Pi process so the assertion is
released if Pi exits unexpectedly.

On non-macOS platforms, the extension is a no-op.

## Configuration

No configuration is required. Disable the extension through `pi config` if you
do not want this behavior.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **System:** macOS `/usr/bin/caffeinate`.
- **Depends on extensions:** None.
- **Used by extensions:** None.
