# hyperlinks

Render local file paths as clickable OSC 8 terminal hyperlinks, and expose the
helper to other extensions.

A path like `src/auth/middleware.ts` becomes a Cmd/Ctrl-clickable link that
opens the file in your `$EDITOR`, without changing its visible width.

## Commands

- `/open-path <path>` — print a clickable link to a path

## Exports

- `hyperlinkPath(display, path, cwd?)` — wrap a display string as a file://
  hyperlink; used by `better-native-pi` for tool-block target paths.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None.
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
