# #355 — the skills epic's hands-on pass (B6)

Evidence for the test plan on [issue #355](https://github.com/amirtuval/openharness/issues/355),
run against the top of the stack (`skills/b6-qa`, on `skills/b6-fixes`).

**The system under test.** The repo built from source (`yarn build`), the server started with
`node apps/server/dist/index.js` serving the built web app (`OPENHARNESS_WEB_DIR`), against a real
Postgres (docker `postgres:18-alpine`, its own database), dev login on, the skills fixture's CA
**and** the sandbox's egress-proxy CA `cat`-ed into one `NODE_EXTRA_CA_CERTS` file, and
`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1`. Two stacks: one on `:3000` with
`OPENHARNESS_TEST_MODEL=mock` for the mechanical cases, and one on `:3100` **without** the mock for
the real-model cases (DeepSeek through the **`deepseek`** provider id — the `openai_compatible`
client is refused by that endpoint's thinking mode, `reasoning_content` must be passed back, the
limitation `packages/brain/AGENTS.md` documents). The web app was driven with Playwright
(headless, scripted); `oh` was driven in a real pty (tmux) with a config home of the run's own.

**Files.** `skills-list-*`, `import-preview-*`, `refresh-diff-*` and `slash-menu-*` are the four
views commit `w30-skills.spec.ts` captures — three themes (`light`/`dim`/`dark`) at a desktop
(1280) and a narrow (~400) width. `cs1-01-pick` and `cs1-02-imported` are the `oh` import pick and
its result, `cs6-01-slash-menu` and `cs6-02-invoked` the `/` menu and a skill invocation in a real
terminal, and `cs4-01-real-model` the real-model run. The captured panes are rendered as
monospace text on a dark page by `e2e/qa/tmux.ts`'s `Terminal.screenshot`, so a `.png` here is the
bytes `tmux` reported.

| case | evidence |
| ---- | -------- |
| S1, S3 | `skills-list-*`, `import-preview-*`, `cs1-01-pick`, `cs1-02-imported` |
| S2 | `import-preview-*` (one candidate, the ref and folder split) |
| S4, S7 | `cs4-01-real-model` |
| S6, S8 | `slash-menu-*`, `cs6-01-slash-menu`, `cs6-02-invoked` |
| S9 | `refresh-diff-*` |
| S14 | all four view sets, in three themes at two widths |
| S5, S10, S11, S12, S13, S15 | no image: the case is about the log, a refusal's status code, or a
list of offered tools, and the capture is text on the issue |
