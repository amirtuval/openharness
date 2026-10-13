# #348 — the subagents epic's hands-on pass

Evidence for the test plan on [issue #348](https://github.com/amirtuval/openharness/issues/348),
run against the top of the stack (`subagents/a8-qa-348`).

**The system under test.** The repo built from source (`yarn build`), the server started with
`nohup node apps/server/dist/index.js` serving the built web app (`OPENHARNESS_WEB_DIR`), against
a real Postgres (docker `postgres:18-alpine`, its own database), dev login on. Two stacks: one on
`:3000` with `OPENHARNESS_TEST_MODEL=mock` **and** lowered limits
(`OPENHARNESS_MAX_AGENT_DEPTH=2`, `OPENHARNESS_MAX_LIVE_TASKS=2`) for A8, and one on `:3100`
without the mock for the real-model cases (DeepSeek through the `deepseek` provider id).
The web app was driven with Playwright (headless, scripted, screenshots); `oh` was driven in a
real pty (tmux) with a config home of the run's own.

**Files.** `w31-*.png` and `a7-*.png` are the Playwright/tmux screenshots the committed specs
take (`e2e/qa/w31-subagents.spec.ts`, `e2e/qa/cli-subagents.spec.ts`); `w31-19..21` are the
real-model run; `captures/` holds text captures for the cases that are about the log rather than
a screen (A13's restarts, and #373's three stop paths).

| case | evidence |
| ---- | -------- |
| A1 two helpers at once | `w31-13-two-helpers-one.png`, `w31-14-two-helpers-running.png`, `w31-15-two-helpers-done.png`; real model: `w31-19-real-two-helpers.png`, `w31-20-real-parent-used-both.png` |
| A2 result timing | asserted from the log in `w31-subagents.spec.ts` (W31f) |
| A3 parent ↔ child messages | `w31-05-card-messages.png`, `w31-04-child-steered.png` |
| A4 continuing a finished child | real model: `w31-21-real-child-continued.png` |
| A5 the user in a child | `w31-16-child-steered.png`, `w31-17-child-interrupted.png`, `w31-03-child-chat.png` |
| A6 non-interactive | `w31-18-child-ask-denied.png` |
| A7 types | `w31-08-mode-subagent-field.png`, `w31-09-mode-subagent-type.png`, `w31-10-settings-tools-agent.png`, `a7-09-oh-modes.png` |
| A8 nesting and limits | asserted from the span's `tools` and the `is_error` in `w31-subagents.spec.ts` (W31j) |
| A9 stop | `w31-06-task-running.png`, `w31-07-task-stopped.png`, `w31-23-task-waiting.png`, `w31-24-task-waiting-stopped.png`, `a7-07-stop-before.png`, `a7-08-stop-after.png`, `captures/a9-paused-child-stop.txt` |
| A10 rewind | `captures/a9-paused-child-stop.txt` (the rewind path), W31k |
| A11 delete | asserted through the API in `w31-subagents.spec.ts` (W31l) |
| A12 sidebar and listing | `w31-02-sidebar-nested.png`, `a8-01-oh-sessions-nested.png` |
| A13 restart mid-task | `captures/a13-restart-mid-task.txt` |
| A14 usage | `w31-01-card-done.png` (`+ subagents $0.0003`), W31l |
| A15 cross-client | `a8-02-web-card-from-oh.png`, `a8-03-web-child-from-oh.png`, `a8-04-oh-agents-same-task.png` |
| A16 layout | `w31-11-*` (Light/Dim/Dark, 1280), `w31-12-narrow-*` (390), `a8-05-card-120.png`, `a8-06-agents-120.png`, `a8-07-agents-80.png`, `a8-08-card-80.png` |
| A17 regression | asserted from the offer and the log in `w31-subagents.spec.ts` (W31m) |
