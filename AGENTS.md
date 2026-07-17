# pi-extensions guidelines

- Write idiomatic, maintainable TypeScript. Prefer small, focused helpers over clever code.
- Add comments only where they explain non-obvious behavior, edge cases, or terminal/TUI safety constraints.
- Add or update tests for extension behavior changes. Keep tests slim and focused on regressions/user-visible behavior.
- Run the relevant focused tests while iterating, then run the full test suite before pushing.
- Update the relevant extension README whenever behavior, commands, configuration, output, or user-facing UX changes.
- Do not commit generated artifacts, dependency directories, logs, or local machine state.
- Never mention another agent harness in code, docs, READMEs, commit messages, or PR bodies. Describe behavior in its own terms ("terminal bell", "focus-aware", etc.) — don't anchor it to how another tool does it.
- Push directly to `main`. Do not open pull requests. Commit with `git commit -S` and `git push origin main`. For noisy/unrelated changes, prefer a separate commit over bundling; squash only if a branch's history is unwieldy. Never bundle unrelated changes into the same commit.
