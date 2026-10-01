# @openharness/e2e

Cross-package (end-to-end) tests: the **built** server in its own process, a real Postgres, and
`@openharness/client` — the same SDK the web app and the TUI use. They exist to prove the thing
no single package can: that the pieces work together, and that what a deployment does to them
(kill the process, drop the stream, fail the model) leaves the session in the state the
protocol says it should.

## Running them

They need a Postgres the test user may create databases on. CI provides one (the workflow's
`postgres` service and its `DATABASE_URL`); locally:

```bash
docker run --rm -d --name oh-postgres -p 5432:5432 \
  -e POSTGRES_USER=openharness -e POSTGRES_PASSWORD=openharness -e POSTGRES_DB=openharness \
  postgres:18-alpine

DATABASE_URL=postgres://openharness:openharness@localhost:5432/openharness yarn test
```

Without `DATABASE_URL` the suite fails with that instruction rather than skipping: an e2e suite
that quietly passes because nothing ran is worse than one that says what it needs. Two files
can skip, and both say why in their output: the provider smoke test (needs a provider key), and
the failover test, which guards against a server without the multi-instance scheduler.

## Commands

Run from this folder (`e2e`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | no-op: this package only holds tests, so it has nothing to build        |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo. The suite runs against `dist/`, so the packages it depends on — server, client, protocol,
web — have to be built before it: `@openharness/e2e` depends on them, which is what makes
turbo's `^build` run first, and what makes `--affected` pick these tests up when the server
changes.

## Public API

Not a published package: it has no `exports` and no build output. What it holds is the tests
and the harness they share (`src/harness/`), which is internal.

## The harness

```ts
const harness = e2eHarness('my-scenario') // registers the teardown itself

const server = await harness.server() // a built server, on a free port
const client = harness.client(server) // @openharness/client, pointed at it
```

| module        | what it is                                                                             |
| ------------- | -------------------------------------------------------------------------------------- |
| `index.ts`    | `e2eHarness(label)`: the file's database, its servers, its clients, its teardown       |
| `database.ts` | `createE2eDatabase(label)`: one Postgres database per test file, dropped in `afterAll` |
| `server.ts`   | `startServerProcess(options)`: the built server as a child process, `/health`-ready    |
| `events.ts`   | reading a session: `readLog`, `collectStream`, `waitForTurnEnd`, the event filters     |
| `wait.ts`     | `waitFor`, `sleep` — polling that fails with what it was waiting for                   |
| `mock.ts`     | `expectedSlowReply()`: the mock model's `__slow__` reply, for exact assertions         |

Four decisions worth knowing before reading the tests:

- **One database per test file.** `createE2eDatabase` creates `openharness_e2e_<label>_<random>`
  on the server `DATABASE_URL` names and drops it in teardown (`with (force)`, so a failed run
  cannot leave one behind). The server under test migrates it on boot — the tests assert the
  boot log says how many migration files it applied. A database rather than a schema, because
  everything shared is per-database: the migration advisory lock, the store's `LISTEN`/`NOTIFY`
  channels and the partition leases.
- **One real process per server.** `startServerProcess` spawns `node <built server>` — resolved
  through `@openharness/server`'s `exports`, never through a path into another package — on a
  free port, with `OPENHARNESS_TEST_MODEL=mock`. The child's environment starts from the test
  process's, minus every `OPENHARNESS_*` variable and `PORT`/`DATABASE_URL`: a leftover variable
  in a developer's shell must not change what a test runs. Provider credentials pass through
  deliberately, which is what the smoke test needs. The process is detached (its own group) and
  killed with `SIGKILL` by default, so nothing it spawned outlives it.
- **Nothing leaks.** Servers are registered as they start and killed in the file's `afterAll`
  (with a process-wide sweep behind that), and the database is dropped last. A test that fails
  half-way through leaves no port bound and no database behind — which matters in CI, where a
  leaked server would hold connections until the job ends.
- **Waits are written against the log.** `waitForTurnEnd(client, id, { afterSeq })` polls the
  session's _status events_, not the session resource: between `POST …/events` and the brain
  writing `session.status_running` the session still reads `idle`, so a test that does not say
  which turn it means can return before that turn started. `afterSeq` (the `seq` of the message
  the test just sent) makes it "the turn after that message ended" — and with no `afterSeq` it
  is "the session has no open turn", which is what a test needs after a restart.

## Scenarios

| file                     | what it drives                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.test.ts`           | a full turn whose chunks are stored under the stored `agent.message`'s id, the documented event order and `MOCK_MODEL_USAGE`; a steering message answered in a second request; an interrupt that keeps the partial reply and is claimed by the span end it stopped; an interrupt with nothing running, claimed by the status idle; a pre-D9 log (no consumes, no supersedes, no chunks) read back correctly |
| `failures.test.ts`       | `__fail_retryable__`: error, reschedule, a fresh request, the reply; `__fail_terminal__`: error, no reply, idle                                                                                                                                                                                                                                                                                             |
| `restart.test.ts`        | `kill -9` mid-`__slow__`, a new process against the same database: the orphaned chunks superseded by a `brain_lost` span end, the turn re-run, idle, no ghost previews                                                                                                                                                                                                                                      |
| `stream-resume.test.ts`  | a stream aborted mid-turn, more turns while nobody listens, a resume from `afterSeq` with no gaps or duplicates; and one stream iteration across a server restart                                                                                                                                                                                                                                           |
| `d9-convergence.test.ts` | D9 (issue #46): a client that followed a reply live, one that joined mid-reply and one that dropped mid-chunks and resumed from there all end deep-equal — before compaction and after the job deleted the chunks; a steered reply in the same order live and after a reload                                                                                                                                |
| `auth.test.ts`           | `OPENHARNESS_API_KEY`: `/health` open, the envelope on `/v1`, the client's `ApiError`, a turn with the key, the stream guarded                                                                                                                                                                                                                                                                              |
| `web-assets.test.ts`     | `OPENHARNESS_WEB_DIR`: the built web app at `/`, its hashed assets, deep links, and the API still under `/v1`                                                                                                                                                                                                                                                                                               |
| `failover.test.ts`       | two instances with `SCHEDULER=postgres`, one killed mid-turn, the other finishing it — see below                                                                                                                                                                                                                                                                                                            |
| `provider-smoke.test.ts` | one turn through a real provider, when a provider key is in the environment                                                                                                                                                                                                                                                                                                                                 |

### The failover test, and how it decides to skip

The test needs the multi-instance scheduler (`SCHEDULER=postgres`, issue #11). On a tree
without it, `SCHEDULER=postgres` would simply be an unknown variable: the server ignores it, comes up on
`LocalScheduler`, and two instances believe they each own every session — which is not
something the server can report, and not something this test can assert against. So the test
**detects** the capability and skips with an explanation instead of guessing. Two checks, in
order:

1. the built server's code never mentions `SCHEDULER` — a variable nothing reads cannot change
   what the process does, so there is nothing to test;
2. an instance started with `SCHEDULER=postgres` and short lease timings
   (`OPENHARNESS_LEASE_TTL_MS`, `OPENHARNESS_HEARTBEAT_MS`) holds no partition lease: a running
   partition scheduler is one with `partition_leases.owner` set, and if nothing claims
   partitions, ownership is recorded some other way than this test assumes.

Either way the skip message says which check failed and what would make the test run. With
#11 in the tree the test runs: both instances start with `SCHEDULER=postgres`, the test looks
up which one owns the session's partition in `partition_leases`, `SIGKILL`s that owner
mid-`__slow__`, and the survivor has to take the partition over and finish the turn.

## Testing

`src/**/*.test.ts` with Vitest (node environment), against the built packages. The package's
`vitest.config.ts` raises the timeout (a `__slow__` reply is ten seconds on purpose, and a
restart test waits out a whole turn) and keeps file parallelism on: each file owns a database,
and they spend their time waiting rather than computing.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `e2e/docs/`.

## Hands-on QA scripts (`qa/`)

`qa/` holds the Playwright (web) and tmux (CLI) specs used for hands-on QA passes (see issue #14). They are
**not** part of `yarn test` or CI.

- Run: `yarn qa:web` against a running system (default `http://localhost:3000`, override with the base-URL env
  var in `playwright.config.ts`), e.g. `OPENHARNESS_TEST_MODEL=mock docker compose up --build`.
- Opt-ins: `QA_WITH_CLI=1` runs the CLI specs (needs `tmux` and a built `apps/tui`);
  `QA_ALLOW_SERVER_RESTART=1` runs the scenarios that stop, kill and recreate the server.
- Screenshots go to `e2e/qa-output/` (gitignored; override with `QA_SHOT_DIR`).
- Results of each pass are reported as a comment on the QA issue, not committed.
- A spec marked `test.fail` documents a known bug; remove the marker once the bug is fixed.

### The model the scenarios run

Every agent the specs create is created on `QA_MODEL` (`support.ts`), which defaults to the id
the specs have always named — the mock passes set nothing and are unchanged. **A pass against a
real provider sets it**, to a router id, and runs the stack without `OPENHARNESS_TEST_MODEL`:

```bash
QA_MODEL=openai/gpt-4.1-mini yarn qa:web
```

`isRealModel` (the same variable, set at all) is what the specs branch on. The mock answers by
echoing its prompt and by its `__slow__` / `__fail_*__` markers; a real provider does none of
those, so a scenario that leans on them either adapts — waiting for a reply to have arrived
rather than for particular words, asking for a long reply instead of `__slow__` — or skips with
`test.skip(isRealModel, …)`. Mock coverage is never removed: the scripted-failure scenarios
(W11a/W11b) run on the mock and skip on a provider, and the provider-only ones (W11d/W11e/W11f,
C11) do the reverse.

### What a clean screen does not prove

A client that **drops stored events it cannot parse** keeps rendering, so a session that has
become unreadable still looks like a session: pass 3's "0[object Object]" usage (#39) made every
real-provider session unreadable to `@openharness/client` while the scenarios — which watched the
console and the text — passed. The app's own error surface is what says a read failed, so every
scenario that opens, reloads or navigates a session now asserts it is clean:

- `expectNoErrorBanner(page)` (`support.ts`) fails on any `role="alert"` the app is showing —
  the chat's "Request failed" banner and the log's own turn errors are one component — and is
  also checked over a short window, since a failed load renders in the pass that ends the load.
- `expectNoErrorNotice(screen)` (`tmux.ts`) fails on the `error: …` line `oh` writes above its
  status line, matched at the start of a line so a reply's own words cannot trip it.

Scenarios that provoke an error on purpose (W11, W12, C9, C11) do not call either.

W14 asks for `CRASH_REPLY_PROMPT` rather than `LONG_REPLY_PROMPT`: `docker compose kill` takes
seconds, and a reply that streams for two of them is finished before the container is down — so
the crash lands after the turn and the scenario fails on a premise it never had. The reply is
sized to outlast the kill, and that it is still arriving is asserted just before the kill.

### A stack that is not plain `docker-compose.yml`

A scenario that kills or recreates the server has to bring it back the way it was started.
`QA_COMPOSE_ARGS` adds arguments to every `docker compose` the specs run, so a deployment that
needs an override file keeps it. The environment is inherited the same way, so a variable the
stack was started with has to be **exported** in the shell that runs the suite: a one-off
`OPENHARNESS_TEST_MODEL=mock docker compose up -d` is not enough, and a restart scenario would
bring the server back without it (W14's re-run would then be answered by the real router).

```bash
QA_COMPOSE_ARGS="-f docker-compose.yml -f docker-compose.proxy.yml" \
  QA_ALLOW_SERVER_RESTART=1 yarn qa:web qa/w14-recovery.spec.ts
```
