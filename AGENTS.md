# pi-extensions guidelines

- Write idiomatic, maintainable TypeScript. Prefer small, focused helpers over clever code.
- Add comments only where they explain non-obvious behavior, edge cases, or terminal/TUI safety constraints.
- Add or update tests for extension behavior changes. Keep tests slim and focused on regressions/user-visible behavior.
- Run the relevant focused tests while iterating, then run the full test suite before pushing.
- Update the relevant extension README whenever behavior, commands, configuration, output, or user-facing UX changes.
- Do not commit generated artifacts, dependency directories, logs, or local machine state.
