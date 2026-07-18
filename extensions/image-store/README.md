# image-store

Keeps image-heavy sessions responsive by storing image bytes as content-addressed
sidecar files instead of embedding base64 payloads in session JSONL.

Images are written under:

```text
~/.pi/agent/image-store/sha256/<prefix>/<sha256>.<ext>
```

The session stores only a small structured SHA-256 reference. Before each model
request, references in the active context are rehydrated in memory, so the model
still receives the original image.

## Terminal behavior

- Tool images render immediately in their native `read` rows for the current
  user-visible run and the previous one.
- Older and resumed tool images stay unloaded until expanded with `Ctrl+O`.
- The elapsed working timer freezes after a live tool image appears, avoiding
  repeated image transfers while normal tool and model updates continue.
- Pasted images use compact transcript references and expand on demand.
- Decoded images use a bounded in-memory cache; collapsed history is not loaded.
- Supported terminals are the same as pi's built-in image component: Kitty,
  iTerm2, Ghostty, WezTerm, and Warp.

Both pasted images and image blocks returned by tools are externalized. The
store is content-addressed, so identical images share one blob across sessions.
If persistence fails, the original embedded image is kept rather than lost.

## Commands

```text
/image-store          Show blob count, size, and storage path
/image-store stats    Same as above
/image-store gc       Delete blobs not referenced by any saved session
```

Garbage collection scans saved sessions and always asks for confirmation before
deleting anything.

## Scope and limitations

- Only images added after the extension loads are externalized.
- Existing sessions are not rewritten automatically.
- Active images are still loaded and base64-encoded for providers; this extension
  targets local session and TUI performance, not model latency.
- Session files are no longer independently portable. Copy the image store when
  moving sessions between machines.
- Built-in HTML export and sharing do not bundle sidecars; they show an external
  image placeholder unless the session is re-embedded first.
- Compaction summaries see the persisted reference rather than the image bytes.

## Dependencies

- **Runtime:** Pi extension and TUI APIs.
- **npm packages:** None.
- **Depends on extensions:** None.
- **Used by extensions:** [`better-native-pi`](../better-native-pi/), [`working-timer`](../working-timer/).
