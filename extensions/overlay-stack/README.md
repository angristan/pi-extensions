# overlay-stack

Internal UI infrastructure for composing independent top-right overlay cards in
a single non-capturing Pi overlay.

Feature extensions register titled sections with an order, preferred width,
visibility predicate, and body renderer. The stack owns consistent accent frames,
spacing, shared sizing, and overlay lifecycle. Press `Alt+O` or run `/overlay` to
hide or show the whole stack. Manual visibility resets when extensions reload or
a new session starts.

The stack also hides automatically while a modal overlay is open. Closing the
modal restores the stack only when it was not manually hidden.

Current cards:

- `goal` — order 5
- `plan-progress` — order 10
- `edit-summary` — order 20

Each visible section is rendered as a separate card with the same width, accent
border, title placement, and padding. Cards are separated by one blank row. The
widest active section determines the common width. If the terminal cannot fit a
lower card within 80% of its height, that card is omitted rather than clipped.

## Dependencies

- **Runtime:** [Pi](https://github.com/earendil-works/pi-coding-agent) extension API.
- **Depends on extensions:** [`accent-color`](../accent-color/).
- **Used by extensions:** [`edit-summary`](../edit-summary/), [`plan-progress`](../plan-progress/).
