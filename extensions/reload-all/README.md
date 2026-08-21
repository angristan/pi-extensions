# reload-all

Reload every top-level interactive Pi process for the current user on one machine.
This is useful after changing or updating shared extensions when many Pi sessions
are open.

Run:

```text
/reload-all
```

After confirmation, the current process publishes a machine-local reload
generation and reloads itself. Other registered Pi TUIs detect that generation,
start an internal apply command, wait until their agent run is fully idle, and
invoke Pi's normal reload flow. A runtime-nonce handshake records success only
when the new extension runtime starts. A failed or refused reload leaves the
generation pending and retries later without creating a reload loop.

## Scope and safety

The extension deliberately excludes:

- child agents identified by `PI_SUBAGENT_CHILD=1`;
- RPC, JSON, and print-mode Pi processes; and
- processes running under another user account or on another device.

On Linux, targets use the boot ID, PID, and `/proc` process-start identity; other
platforms use the strongest available subset. A heartbeat helps inspect runtime
state, but targets are not expired by age because a suspended process must reload
when it resumes. Dead and PID-reused targets are removed when the next broadcast
inventories live sessions. New Pi processes treat the current generation as
already applied, so starting a session after a broadcast does not cause an
unnecessary reload.

Coordination state is stored with owner-only permissions under
`$XDG_RUNTIME_DIR/pi-reload-all/`, with a user-specific temporary-directory
fallback when `XDG_RUNTIME_DIR` is unavailable. It contains process identity and
generation metadata, not prompts, session content, credentials, or model data.

A session blocked inside a questionnaire or another operation that never settles
will not reload automatically. Finish or cancel that operation, then run
`/reload` in that session if needed.

The broadcast protocol must already be loaded in a process to reach it. The first
installation therefore still requires one manual `/reload` or restart per existing
Pi process. Later extension updates can use `/reload-all`.

## Dependencies

- **Runtime:** Pi extension command, session lifecycle, and reload APIs.
- **npm packages:** None.
- **External services:** None.
