# Decisions

Architecture Decision Records (ADRs) capture **why** a decision was made, at the moment it was
made. The alternative is losing the reasoning and re-litigating it later.

There are no ADRs yet.

## When to write one

Write an ADR when a decision is:

- hard to reverse (a storage engine, a wire format, a public API), or
- surprising to a future reader ("why is this package not allowed to import that one?"), or
- a deliberate deviation from the obvious choice.

Skip it for decisions that are already obvious from the code or already recorded in an issue.

## Convention

- One file per decision: `NNNN-short-title.md` (e.g. `0001-session-log-storage.md`), numbered
  in order, never renumbered.
- An ADR is immutable once accepted. To change a decision, add a new ADR that supersedes the
  old one and link them to each other.
- Statuses: `proposed`, `accepted`, `superseded by NNNN`.
- Keep it short: the template below fits on one screen.

## Template

```markdown
# NNNN. Title

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context

What forces are at play? Which constraints (product, budget, team size, deadline) matter?
Facts only, no opinions yet.

## Decision

What we are doing, in the active voice: "We will ...".

## Consequences

What becomes easier, what becomes harder, and what we accept as a downside. Include the
follow-up work this creates.
```
