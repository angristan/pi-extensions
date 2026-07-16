# overlay-stack

Internal UI infrastructure for composing independent top-right overlay cards in
a single non-capturing Pi overlay.

Feature extensions register cards with an order, width, visibility predicate,
and render function. The stack owns overlay lifecycle and layout only; it has no
commands, persistence, or feature state.

Current cards:

- `plan-progress` — order 10
- `edit-summary` — order 20

Visible cards are rendered vertically with a one-row gap. Narrower cards are
right-aligned. If the terminal cannot fit a lower card within 80% of its height,
that card is omitted rather than clipped.
