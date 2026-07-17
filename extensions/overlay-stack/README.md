# overlay-stack

Internal UI infrastructure for composing independent top-right overlay cards in
a single non-capturing Pi overlay.

Feature extensions register titled sections with an order, preferred width,
visibility predicate, and body renderer. The stack owns consistent accent frames,
spacing, shared sizing, and overlay lifecycle only; it has no commands,
persistence, or feature state.

Current cards:

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
