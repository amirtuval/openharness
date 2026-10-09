# Workflow

How work happens in this repo.

1. **Everything is a GitHub issue.** Large work is an epic; the epic is split into sub-issues.
   Nothing gets implemented without an issue to hang it on.

2. **Every implementation agent gets its own sub-issue.** The sub-issue is a complete brief —
   goal, context, fixed decisions, layout, acceptance criteria — plus a link to the parent
   epic. An agent should be able to do the work from the issue alone, without asking for
   context it cannot see.

3. **One issue, one branch, one PR.** Implementation happens on a branch; the PR references
   the issue. CI must pass. The maintainer does the final merge — authors do not merge their
   own PRs.

4. **Docs are part of the change.** Root docs (`README.md`, `AGENTS.md`, `docs/`) and the
   package's `AGENTS.md` are updated in the same branch, before merge, whenever behaviour or
   the public API changes.

5. **`docs/` stays high level.** Package details live in `<package>/AGENTS.md` and, when they
   outgrow it, `<package>/docs/`. Design specs live in issues, not in the repo.

## Related

- Architecture and the allowed dependency graph: [`architecture.md`](./architecture.md).
- Commands, tooling and how to work inside one package: [`development.md`](./development.md).
- Decisions and their rationale: [`decisions/`](./decisions/README.md).
