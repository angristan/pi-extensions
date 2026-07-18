# pi-extensions guidelines

- Write idiomatic, maintainable TypeScript. Prefer small, focused helpers over clever code.
- Add comments only where they explain non-obvious behavior, edge cases, or terminal/TUI safety constraints.
- Treat model context as a shared budget: keep always-on schemas, descriptions, prompt metadata, agent instructions, and tool outputs concise and non-duplicative; prefer deferred activation for rarely used tools, measure before/after, and add behavior coverage for context optimizations.
- Before adding or updating a tool, inspect comparable tools in this repository and match their interaction and visual language: naming, schema metadata, collapsed and expanded rendering, semantic colors and icons, spacing, truncation, progress, success, empty, and error states. Reuse shared helpers and patterns where practical, cover the rendered states in tests, and make any intentional divergence explicit.
- Add or update tests for extension behavior changes. Keep tests slim and focused on regressions/user-visible behavior.
- Treat settled and persisted transcript rows as immutable snapshots. Never read `Date.now()`, mutable process state, or other live values from a historical component's `render()` path; capture observation data once and test that repeated renders stay byte-identical.
- Treat TUI redraws as potentially expensive and viewport-disrupting in very long sessions. Prefer width-keyed caches and change-driven invalidation; avoid autonomous/global redraws, off-screen row mutation, and full-transcript recomputation, and test idle behavior with a scrolled viewport in mind.
- Run the relevant focused tests while iterating, then run the full test suite before pushing.
- Update the relevant extension README whenever behavior, commands, configuration, output, or user-facing UX changes.
- Do not commit generated artifacts, dependency directories, logs, or local machine state.
- Never mention another agent harness in code, docs, READMEs, commit messages, or PR bodies. Describe behavior in its own terms ("terminal bell", "focus-aware", etc.) — don't anchor it to how another tool does it.
- Push directly to `main`. Do not open pull requests. Commit with `git commit -S` and `git push origin main`. For noisy/unrelated changes, prefer a separate commit over bundling; squash only if a branch's history is unwieldy. Never bundle unrelated changes into the same commit.
