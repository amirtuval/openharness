# #355 QA re-run — `skills/b7-review-fixes`

Screenshots and terminal captures from the pre-staging re-run of issue #355's S1–S15 at
`a811391` (PR #390), against a real Postgres (postgres:18-alpine) and the built server.

- `w30-*` / `skills-list-*` / `import-preview-*` / `refresh-diff-*` / `slash-menu-*` — the web
  spec (`e2e/qa/w30-skills.spec.ts`), S1–S3, S6, S8–S11, S14.
- `cs*` — the `oh` spec (`e2e/qa/cli-skills.spec.ts`, `QA_WITH_CLI=1`) and the S13/S5 hand-run
  captures (`s5-*`, `s13-*`).
- `w31-*` — the subagents regression spec (`e2e/qa/w31-subagents.spec.ts`).
- `cs4-01-real-model.png` — S4 on DeepSeek (`deepseek/deepseek-flash`).
