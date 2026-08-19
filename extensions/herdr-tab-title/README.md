# herdr-tab-title

Keeps the current [Herdr](https://herdr.dev/) tab label synchronized with the
Pi session name. It handles names created by `/name`, RPC clients, or session
naming extensions through Pi's standard `session_info_changed` event.

The extension activates only in a Herdr-managed TUI. It sends `tab.rename` to
the local Herdr socket identified by `HERDR_SOCKET_PATH` and `HERDR_TAB_ID`; it
performs no network requests. Empty and headless session names are ignored.

A later Pi session-name change replaces the current Herdr tab label, including
a label that was set manually in Herdr. To avoid Herdr asking for an initial
label before Pi supplies one, set:

```toml
[ui]
prompt_new_tab_name = false
```

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** None. It works with any source of Pi session names.
- **Used by extensions:** None.
- **System/services:** Herdr with `HERDR_ENV`, `HERDR_SOCKET_PATH`, and
  `HERDR_TAB_ID` available to the Pi process.
