# reload-all

Reload all top-level Pi TUIs for the current user on one machine.

Use this after updating shared extensions, skills, prompts, themes, or settings
when several Pi sessions are open:

```text
/reload-all
```

Pi shows the number of registered sessions and asks for confirmation. The current
session reloads immediately. Other sessions reload as soon as their active agent
run is fully idle.

## First-time setup

A process must already have this extension loaded before it can receive a reload
broadcast. After installing `reload-all`, run `/reload` once—or restart Pi—in each
existing session.

This bootstrap is needed only once. Future updates can use `/reload-all`.

## Behavior

```text
session A: /reload-all
              |
              v
    publish local generation
        /          |          \
       v           v           v
 session A     session B     session C
 reload now    wait if busy   reload now
                   |
                   v
              reload when idle
```

Each participating TUI registers a small machine-local target. A broadcast:

1. writes a new reload generation atomically;
2. asks each target to wait for Pi to become fully idle;
3. invokes Pi's normal reload flow; and
4. records success only after the new extension runtime starts.

The runtime handshake prevents loops. If Pi rejects, refuses, or fails a reload,
the generation remains pending and the session retries later.

Only `/reload-all` appears in command completion. Internal coordination is handled
as a validated private form of that command.

## Included processes

A process participates only when all of these are true:

- it is a top-level Pi process;
- it runs in interactive TUI mode;
- it runs as the same operating-system user; and
- it runs on the same machine.

The extension excludes child agents (`PI_SUBAGENT_CHILD=1`), RPC processes, JSON
mode, and print mode. It does not broadcast across machines or devices.

## Busy and suspended sessions

Active sessions wait for `ctx.waitForIdle()` before reloading. This includes agent
runs, retries, automatic compaction retries, and queued continuations.

A suspended process keeps its registration and handles the current generation
when it resumes. A session blocked indefinitely in a questionnaire or another
operation cannot become idle; finish or cancel that operation, then use `/reload`
in that session if needed.

A Pi process started after a broadcast treats the current generation as already
applied and does not reload unnecessarily.

## Runtime state and safety

State is stored with owner-only permissions in:

```text
$XDG_RUNTIME_DIR/pi-reload-all/
```

When `XDG_RUNTIME_DIR` is unavailable, the extension uses
`/tmp/pi-reload-all-<uid>/`.

The state contains only generation and process-identity metadata. It never stores
prompts, conversation content, credentials, or model data. Files are bounded,
validated, and written atomically; symbolic-link state files are rejected.

On Linux, process identity combines the boot ID, PID, and `/proc` process-start
value. This prevents stale registrations and PID reuse from targeting an unrelated
process. Other platforms use the strongest available subset. Dead targets are
removed during the next broadcast inventory.

## Troubleshooting

### A session did not reload

Check these conditions:

1. The session loaded the extension at least once.
2. It is a top-level interactive TUI on the same machine and user account.
3. It is not blocked in a questionnaire or another operation.

Run `/reload` manually in that session to bootstrap or recover it.

### `/reload-all` is duplicated or renamed

The extension refuses to inject its private coordination form when another
extension collides with the `/reload-all` command name. Remove the duplicate
registration, reload Pi, and try again.

## Dependencies

- **Runtime:** Pi extension command, session lifecycle, and reload APIs.
- **npm packages:** None.
- **External services:** None.
