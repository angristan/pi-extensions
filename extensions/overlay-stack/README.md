# overlay-stack

Internal UI infrastructure for composing independent top-right overlay cards in
a single non-capturing Pi overlay.

Feature extensions register titled sections with an order, preferred width,
visibility predicate, and body renderer. The stack owns the shared accent border,
section dividers, sizing, and overlay lifecycle only; it has no commands,
persistence, or feature state.

Current cards:

- `plan-progress` — order 10
- `edit-summary` — order 20

Visible sections share one outer frame and are separated by labeled divider
rows. The widest active section determines the common width. If the terminal
cannot fit a lower section within 80% of its height, that section is omitted
rather than clipped.
