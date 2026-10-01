import { execFileSync } from 'node:child_process'
import path from 'node:path'

import {
  expect,
  test as base,
  type APIRequestContext,
  type Cookie,
  type Page,
} from '@playwright/test'

/**
 * What the `playwright` fixture is, structurally: the one thing this file calls on it.
 *
 * Typed here rather than by name because `@playwright/test` re-exports the value without a
 * name for its type; the shape is the fixture's, and the compiler checks the assignment.
 */
interface PlaywrightApi {
  readonly request: {
    newContext(options: { readonly baseURL: string }): Promise<APIRequestContext>
  }
}

/**
 * Shared helpers for the #14 QA pass: the base URL, the console-error collector, screenshots
 * and a thin wrapper over the HTTP API for setup and for assertions that are about the log
 * rather than the pixels.
 *
 * ## Signing in
 *
 * Since epic #65 the server is not open: every `/v1` call needs a session, and the app shows
 * its sign-in page until it has one. The QA stack runs with `OPENHARNESS_DEV_LOGIN=1` on
 * localhost (A7), whose one user the specs sign in as **once per worker**: the session's
 * bearer token becomes the `request` fixture's default `authorization` header, and its cookie
 * is put on the browser context, so a spec starts signed in on both sides and says nothing
 * about it. (One sign-in, not one per test: `/api/auth/sign-in/email` is rate-limited to three
 * per ten seconds — A2 — and a suite that signs in per test would trip its own limit.)
 *
 * The three specs that are *about* signing in do it their own way: `w15-sign-in.spec.ts` and
 * `w16-sign-out.spec.ts` open a context with no session at all, and `cli.spec.ts`'s login
 * scenarios run the device flow for real.
 */

/** Where the app under test lives. Same default as `playwright.config.ts`. */
export const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3000'

/** Where screenshots land. Relative paths resolve against the `e2e` package folder. */
const SHOT_DIR = process.env.QA_SHOT_DIR ?? 'qa-output'

/**
 * The dev user the QA stack is signed in as (A7).
 *
 * The documented pair; override with `QA_DEV_EMAIL`/`QA_DEV_PASSWORD` for a stack whose dev
 * login is configured differently.
 */
export const DEV_LOGIN_EMAIL = process.env.QA_DEV_EMAIL ?? 'dev@localhost'
export const DEV_LOGIN_PASSWORD = process.env.QA_DEV_PASSWORD ?? 'dev'

/** A name that no earlier run can collide with. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`
}

/**
 * The model the QA agents are created on.
 *
 * The mock passes leave this alone: the default is the model id the specs have always named,
 * and the server under test runs `OPENHARNESS_TEST_MODEL=mock`, which answers every turn
 * itself and never resolves the id. A pass against a real provider sets `QA_MODEL` to a
 * router id (e.g. `openai/gpt-4.1-mini`) and runs the stack without that variable.
 */
export const QA_MODEL = process.env.QA_MODEL ?? 'anthropic/claude-sonnet-5'

/**
 * Whether this run is against a real provider rather than the mock model.
 *
 * Setting `QA_MODEL` at all is the signal: the default above is the model every spec has
 * always named, and the mock passes do not set it. A spec that leans on the mock's scripted
 * replies — the `__slow__`/`__fail_*__` markers, or the way it echoes its prompt — asks this
 * and either adapts or skips.
 */
export const isRealModel = process.env.QA_MODEL !== undefined

/**
 * How far the long reply counts.
 *
 * Several scenarios need a reply that is still arriving when the next thing happens (a reload,
 * a steering message, a Stop) and that is taller than a terminal pane. The mock has `__slow__`
 * for that; a real model has to be asked for something long, and counting is the cheapest way
 * to get something that streams steadily. It is deliberately not longer: a real provider is
 * slower and rate-limited, and these scenarios do not need a *big* reply, only a live one.
 */
export const LONG_REPLY_COUNT = 60

/** A prompt a real provider answers at length. */
export const LONG_REPLY_PROMPT = `Count from 1 to ${String(LONG_REPLY_COUNT)}, one number per line. Nothing else.`

/** The line the long reply ends with, which is how "it finished" reads on screen. */
export const LONG_REPLY_END = new RegExp(`^\\s*${String(LONG_REPLY_COUNT)}\\s*$`, 'm')

/**
 * A longer reply still, for the scenario that kills the server in the middle of one.
 *
 * {@link LONG_REPLY_PROMPT} streams in about two seconds, and `docker compose kill` takes a
 * couple more: a provider that answers that fast is finished before the container is down, so
 * the crash lands after the turn and there is nothing for the next process to re-run. W14
 * needs the request to still be open when the container goes, and this is a reply several
 * times longer than the kill takes — the 400 numbers below stream for around seven seconds
 * on `openai/gpt-4.1-mini`.
 */
export const CRASH_REPLY_COUNT = 400

/** A prompt a real provider answers slowly enough to be interrupted by a container kill. */
export const CRASH_REPLY_PROMPT = `Count from 1 to ${String(CRASH_REPLY_COUNT)}, one number per line. Nothing else.`

/** The line the crash-recovery reply ends with. */
export const CRASH_REPLY_END = new RegExp(`^\\s*${String(CRASH_REPLY_COUNT)}\\s*$`, 'm')

/**
 * A longer reply still, for the scenario that reloads the page in the middle of one.
 *
 * {@link LONG_REPLY_COUNT} numbers stream in a couple of seconds — long enough for a steering
 * message or a Stop, which are sent from the same page, but not for a reload, a reconnect and
 * a replay. This is the one scenario whose reply has to outlast that round trip, so it asks for
 * a bigger one: at 150 the reload had to land inside a ~3 s window, which a fast provider beats
 * on a slow round trip (the reload, the error-banner assertion this pass added, and the polling
 * in between all count against it). Roughly twice that streams for around six seconds on
 * `openai/gpt-4.1-mini`, which is the margin the premise needs.
 */
export const RELOAD_REPLY_COUNT = 300

/** A prompt a real provider answers at length, for the mid-reload scenario. */
export const RELOAD_REPLY_PROMPT = `Count from 1 to ${String(RELOAD_REPLY_COUNT)}, one number per line. Nothing else.`

// --- the signed-in session every spec starts from -------------------------------------------

/** One dev-login session: the bearer token for the API, and the cookie for the browser. */
export interface DevSession {
  /** The session token, sent as `Authorization: Bearer` — what `oh` stores for the CLI. */
  readonly token: string
  /** The same session as the app's cookie, for the browser context. */
  readonly cookies: readonly Cookie[]
}

let devSessionPromise: Promise<DevSession> | undefined

/**
 * Sign in as the dev user, once per worker, and share it with every spec.
 *
 * The sign-in goes through the real endpoint (`POST /api/auth/sign-in/email`), so the specs
 * run against the same authentication a person does; caching it is what keeps the suite inside
 * Better Auth's rate limit (three sign-ins per ten seconds, A2). A spec that needs a session
 * of its own — or none at all — opens its own browser context and signs in through the UI
 * instead of asking for this one.
 */
export function devSession(playwright: PlaywrightApi, baseURL: string): Promise<DevSession> {
  devSessionPromise ??= signInOverDev(playwright, baseURL)
  return devSessionPromise
}

async function signInOverDev(playwright: PlaywrightApi, baseURL: string): Promise<DevSession> {
  const context = await playwright.request.newContext({ baseURL })
  try {
    // Sign-in allows three attempts per ten seconds (A2). The specs share one sign-in, so this
    // only bites when a previous *run* left the counter warm; waiting out the window is what a
    // person would do, and it keeps a fresh suite from failing on a timing accident.
    let response = await signInRequest(context)
    if (response.status() === 429) {
      await new Promise((resolve) => setTimeout(resolve, 11_000))
      response = await signInRequest(context)
    }
    if (!response.ok()) {
      throw new Error(
        `the dev login failed (${String(response.status())}): ${await response.text()}\n` +
          'Is the stack running with OPENHARNESS_DEV_LOGIN=1 on localhost (A7)?',
      )
    }
    const body = (await response.json()) as { token?: string }
    if (typeof body.token !== 'string') {
      throw new Error('the sign-in answer carried no token')
    }
    const { cookies } = await context.storageState()
    return { token: body.token, cookies }
  } finally {
    await context.dispose()
  }
}

/** One `POST /api/auth/sign-in/email` as the dev user. */
function signInRequest(context: APIRequestContext) {
  return context.post('/api/auth/sign-in/email', {
    data: { email: DEV_LOGIN_EMAIL, password: DEV_LOGIN_PASSWORD },
  })
}

// --- the stack itself, for the scenarios that stop and start it -------------------------------------

/** The container the compose file names for the server. */
export const SERVER_CONTAINER = process.env.QA_SERVER_CONTAINER ?? 'openharness-server-1'

/**
 * Extra `docker compose` arguments, for a stack that is not plain `docker-compose.yml`.
 *
 * A restart scenario has to bring the server back up the way it was started, and a deployment
 * can be more than the one file — this pass runs with a second one that puts an egress proxy in
 * front of the container. Empty by default, so nothing changes for a plain stack.
 */
const COMPOSE_ARGS = (process.env.QA_COMPOSE_ARGS ?? '').split(' ').filter((arg) => arg !== '')

/** The repository root: where `docker compose` finds the file the stack was started from. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

/**
 * `docker compose` against the stack under test, from the repository root.
 *
 * `env` is merged over this process's environment, which is how a service's configuration is
 * changed: `up -d` recreates a container whose environment differs from the running one.
 */
export function composeServer(env: NodeJS.ProcessEnv = {}, ...args: string[]): void {
  execFileSync('docker', ['compose', ...COMPOSE_ARGS, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  })
}

/**
 * The value of an environment variable inside the running server container, or `null` when the
 * container does not set it.
 *
 * For the §8 scenario of the #74 pass, which has to prove a variable *is* in the container's
 * environment before it can prove the server ignores it — and that it is gone afterwards. The
 * callers compare lengths or emptiness, so the value itself is never printed.
 */
export function serverContainerEnv(name: string): string | null {
  try {
    return execFileSync(
      'docker',
      ['compose', ...COMPOSE_ARGS, 'exec', '-T', 'server', 'printenv', name],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trimEnd()
  } catch {
    return null
  }
}

/** Wait for the server to answer `/health` again after a restart. */
export async function waitForHealth(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${BASE_URL}/health never came back`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Sign in through the page's dev form, waiting out the rate limit if it is hit.
 *
 * `/api/auth/sign-in/email` allows three attempts per ten seconds per address (A2), and the
 * scenarios that sign in through the page — W15 and W16 — run next to each other. A person
 * who typed too fast would see "Too many requests. Please try again later."; this does what
 * they would do, and retries once the window has passed. Any other refusal is thrown at once.
 */
export async function signInWithDevForm(
  page: Page,
  credentials: { readonly email?: string; readonly password?: string } = {},
): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    await page.getByLabel('Username').fill(credentials.email ?? DEV_LOGIN_EMAIL)
    await page.getByLabel('Password').fill(credentials.password ?? DEV_LOGIN_PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    const failed = page.getByRole('alert').filter({ hasText: 'Sign-in failed' })
    const refused = page.getByRole('alert').filter({ hasText: /Too many requests/ })
    await expect(failed.or(page.getByRole('button', { name: 'Sign out' }))).toBeVisible({
      timeout: 15_000,
    })
    if (!(await refused.isVisible().catch(() => false))) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error('the dev sign-in stayed rate-limited')
    }
    // The limit's window is ten seconds; wait it out and try again, as a person would.
    await page.waitForTimeout(11_000)
  }
}

/**
 * Console errors, collected for the whole test.
 *
 * The browser console is one of the things this pass exists to look at, so every scenario
 * attaches this and asserts on it: a React warning or a failed request shows up here long
 * before it shows up as a broken screen.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(`console.error: ${message.text()}`)
      }
    })
    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${error.message}`)
    })
    await use(errors)
  },
  /**
   * The browser context, signed in: the dev session's cookie is put on it before the first
   * `goto`, so the app never shows its sign-in page to a scenario that is not about it.
   */
  context: async ({ context, playwright, baseURL }, use) => {
    const session = await devSession(playwright, baseURL ?? BASE_URL)
    await context.addCookies([...session.cookies])
    await use(context)
  },
  /**
   * The HTTP API, signed in: every `request.get`/`request.post` a spec makes carries the dev
   * session's bearer token. A spec that wants to call the API anonymously (the sign-in
   * scenarios) builds its own context with `playwright.request.newContext()`.
   */
  request: async ({ playwright, baseURL }, use) => {
    const session = await devSession(playwright, baseURL ?? BASE_URL)
    const api = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { authorization: `Bearer ${session.token}` },
    })
    await use(api)
    await api.dispose()
  },
})

export { expect }

/** Patterns that are noise in this environment and never a finding on their own. */
const BENIGN_CONSOLE = [/favicon\.ico/i, /Download the React DevTools/i]

/** Fail unless the console was quiet, printing everything it was not so. */
export function expectNoConsoleErrors(errors: readonly string[]): void {
  const real = errors.filter((entry) => !BENIGN_CONSOLE.some((pattern) => pattern.test(entry)))
  expect(real, `browser console errors:\n${real.join('\n')}`).toEqual([])
}

/** A screenshot in the report's folder, at a fixed size so runs are comparable. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), animations: 'disabled' })
}

// --- what the app does when something fails ---------------------------------------------------------

/**
 * The app's error surfaces: everything it renders as `role="alert"`.
 *
 * Two things in the chat are `ErrorBanner`s — a request this app made that failed
 * (`requestError`: the history load, the send, the interrupt) and a `session.error` from the
 * log (`lastError`) — and the sidebar's own list failure is an alert too
 * (`apps/web/src/components/chat/chat-view.tsx`, `sidebar.tsx`). So this is every in-app
 * error surface, not only the one a scenario happens to be about.
 */
export function errorBanners(page: Page) {
  return page.getByRole('alert')
}

/**
 * How long {@link expectNoErrorBanner} watches the page before it says there is no banner.
 *
 * Short on purpose. It is not there to catch a banner that appears later in a scenario — every
 * scenario calls this again once its turn is over, which is where a late one turns up — but to
 * keep the check honest about the moment it is made: a scenario that has a premise riding on
 * how long a live stream still lasts (a reload that has to land mid-stream, a kill that has to
 * land mid-request) cannot afford a second of clock.
 */
const BANNER_SETTLE_MS = 500

/**
 * Fail if the app is showing an error banner.
 *
 * This is the assertion pass 3 was missing. The client **drops stored events it cannot parse**
 * and keeps rendering, so a session that became unreadable still looked like a session: #39
 * turned every real-provider session's usage into `"0[object Object]"`, `@openharness/client`
 * refused to read the log, and the specs — which watched the console and the on-screen text —
 * passed anyway. What says a read failed is this banner, so every scenario that opens,
 * reloads or navigates a session asserts it is not there.
 *
 * A failed history load sets `requestError` in the same React pass that stops the "Loading the
 * conversation…" line, so the banner is there by the time a navigation has settled;
 * {@link BANNER_SETTLE_MS} is what makes "and it did not appear just after" part of the
 * assertion rather than a race with the render.
 *
 * Scenarios that provoke an error on purpose — W11, W15, W16, W17, C9, C11 — are the ones where a banner
 * is the expected reading, and they do not call this.
 */
export async function expectNoErrorBanner(page: Page, settleMs = BANNER_SETTLE_MS): Promise<void> {
  const banners = errorBanners(page)
  const deadline = Date.now() + settleMs
  for (;;) {
    const texts = (await banners.allTextContents())
      .map((text) => text.trim())
      .filter((text) => text !== '')
    expect(texts, 'the app is showing an error banner').toEqual([])
    if (Date.now() >= deadline) {
      return
    }
    await page.waitForTimeout(100)
  }
}

// --- a thin client for the HTTP API -----------------------------------------------------------------

/** Create an agent and answer it. Throws with the server's envelope when it says no. */
export async function createAgent(
  request: APIRequestContext,
  values: { name: string; model: string; system: string },
): Promise<{ id: string; name: string }> {
  const response = await request.post('/v1/agents', {
    data: { name: values.name, model: { id: values.model }, system: values.system },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as { id: string; name: string }
}

/** Create a session on an agent. */
export async function createSession(
  request: APIRequestContext,
  agentId: string,
): Promise<{ id: string }> {
  const response = await request.post('/v1/sessions', {
    data: { agent: agentId },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as { id: string }
}

/**
 * Every agent the server has, oldest first.
 *
 * `next_page` matters here: the API answers one page at a time, and a QA server that has been
 * used for a while holds far more agents than fit in one. A scenario that looks for the agent
 * it just created has to walk the cursor, or it is looking for the newest agent in the oldest
 * hundred.
 */
export async function listAllAgents(
  request: APIRequestContext,
): Promise<{ id: string; name: string; system: string | null; model: { id: string } }[]> {
  const agents: { id: string; name: string; system: string | null; model: { id: string } }[] = []
  let page = ''
  for (;;) {
    const response = await request.get('/v1/agents', {
      params: { limit: 100, ...(page === '' ? {} : { page }) },
    })
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      data: { id: string; name: string; system: string | null; model: { id: string } }[]
      next_page: string | null
    }
    agents.push(...body.data)
    if (body.next_page === null) {
      return agents
    }
    page = body.next_page
  }
}

/** Read one session. */
export async function getSession(
  request: APIRequestContext,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(`/v1/sessions/${sessionId}`)
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

/** Append a user message, the way the composer does. */
export async function sendMessage(
  request: APIRequestContext,
  sessionId: string,
  text: string,
): Promise<number> {
  const response = await request.post(`/v1/sessions/${sessionId}/events`, {
    data: { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] },
  })
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { data: { seq: number }[] }
  return body.data[0]?.seq ?? 0
}

/** The whole log of a session, oldest first. */
export async function readEvents(
  request: APIRequestContext,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  let page = ''
  do {
    const response = await request.get(`/v1/sessions/${sessionId}/events`, {
      params: { limit: 100, ...(page === '' ? {} : { page }) },
    })
    expect(response.status(), await response.text()).toBe(200)
    const body = (await response.json()) as {
      data: Record<string, unknown>[]
      next_page: string | null
    }
    events.push(...body.data)
    page = body.next_page ?? ''
  } while (page !== '')
  return events
}

/**
 * Fill a session with a few finished turns, through the API, before the browser opens it.
 *
 * Scrolling and reload scenarios need a conversation taller than the window; waiting for
 * that through the UI would cost more than the assertions are worth.
 */
export async function seedTurns(
  request: APIRequestContext,
  sessionId: string,
  texts: readonly string[],
): Promise<void> {
  for (const text of texts) {
    await sendMessage(request, sessionId, text)
    await waitForIdle(request, sessionId)
  }
}

/** The event types of a session's log, in order. */
export async function eventTypes(request: APIRequestContext, sessionId: string): Promise<string[]> {
  return (await readEvents(request, sessionId)).map((event) => String(event.type))
}

/** Wait until the session has no turn open — the log says `status_idle` last. */
export async function waitForIdle(
  request: APIRequestContext,
  sessionId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const types = await eventTypes(request, sessionId)
    const lastStatus = types.filter((type) => type.startsWith('session.status_')).at(-1)
    if (lastStatus === 'session.status_idle') {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never went idle (log: ${types.join(', ')})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// --- the app ---------------------------------------------------------------------------------------

/** Open a chat and wait for its history to have been folded in. */
export async function openChat(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/#/s/${sessionId}`)
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  await expect(page.getByText('Loading the conversation…')).toHaveCount(0)
}

/** The composer, addressed the way a user does: the box they type in. */
export function composer(page: Page) {
  return page.locator('#composer-input')
}

/** Type a message and press Enter, which is how the composer sends. */
export async function sendFromComposer(page: Page, text: string): Promise<void> {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

/**
 * Wait for a long reply to be genuinely under way.
 *
 * The mock's `__slow__` reply counts itself off — `part 1/40`, `part 2/40`, … — so the marker
 * is what says it has started. A real provider's reply carries no such marker, and waiting for
 * its wording is not possible: there, "under way" is a length.
 */
export async function waitForLongReplyStart(
  page: Page,
  options: { readonly minLength?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!isRealModel) {
    await expect(page.locator('article[data-role="agent"]').last()).toContainText('part 1/40', {
      timeout: timeoutMs,
    })
    return
  }
  const minLength = options.minLength ?? 1
  await expect
    .poll(async () => (await lastAgentText(page)).trim().length >= minLength, {
      timeout: timeoutMs,
      message: `the long reply never reached ${String(minLength)} characters`,
    })
    .toBe(true)
}

/**
 * The screen-reader line the app puts inside an agent message that is still being written.
 *
 * It is not part of the reply, but it is part of the element's `textContent` — so a read of
 * "what the agent said" has to take it out, or an empty reply looks like a reply
 * (`apps/web/src/components/chat/message-item.tsx`, and the same note in the package's own
 * render-app test support).
 */
const REPLYING_STATUS = 'The assistant is replying…'

/** `text` without the screen-reader status line. */
function withoutReplyingStatus(text: string): string {
  return text.replace(REPLYING_STATUS, '')
}

/** Every message on screen, oldest first, as `role:text`. */
export async function transcript(page: Page): Promise<string[]> {
  return page
    .locator('article[data-role]')
    .evaluateAll(
      (nodes, status) =>
        nodes.map(
          (node) =>
            `${node.getAttribute('data-role') ?? '?'}:${(node.textContent ?? '').replace(status, '')}`,
        ),
      REPLYING_STATUS,
    )
}

/** The text of the agent's newest message, or `''` when there is none yet. */
export async function lastAgentText(page: Page): Promise<string> {
  const text = (await page.locator('article[data-role="agent"]').last().textContent()) ?? ''
  return withoutReplyingStatus(text)
}

/**
 * Wait for the agent's newest message to hold an answer to `prompt`.
 *
 * The mock model replies by echoing its prompt, and the specs written for passes 1 and 2 wait
 * for a reply by looking for the prompt inside it. A real provider answers in its own words,
 * so there is nothing to match on — only that a reply arrived, grown to `minLength`
 * characters. Wording is not a contract, so neither mode asserts on it.
 */
export async function waitForAnswer(
  page: Page,
  prompt: string,
  options: { readonly timeoutMs?: number; readonly minLength?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const minLength = options.minLength ?? 1
  await expect
    .poll(
      async () => {
        const text = await lastAgentText(page)
        return isRealModel ? text.trim().length >= minLength : text.includes(prompt)
      },
      { timeout: timeoutMs, message: `the agent never answered ${JSON.stringify(prompt)}` },
    )
    .toBe(true)
}

/** The status the header shows. */
export function status(page: Page) {
  return page.getByRole('status', { name: /^Status: / })
}

/** The scrolling conversation element. */
export function conversation(page: Page) {
  return page.getByRole('log', { name: 'Conversation' })
}

/** How far the conversation is scrolled from its bottom, in pixels. */
export async function distanceFromBottom(page: Page): Promise<number> {
  return conversation(page).evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )
}

/**
 * Watch the page render, one mutation at a time.
 *
 * A deterministic reply to an ordinary message is four chunks 25 ms apart, which is over
 * before an assertion can poll for it. So instead of sampling, this records every render of
 * the agent's live reply — its text length and whether it is marked as streaming — and the
 * test reads the series afterwards. "Streams in" and "the status goes running" are then
 * questions about the series, not about catching a moment.
 */
export interface GrowthSample {
  /** Characters in the agent's streaming message at that render. */
  readonly length: number
  /** The status label the header showed at that render, or `null` if there was none. */
  readonly status: string | null
}

export async function recordRendering(page: Page): Promise<void> {
  await page.evaluate(() => {
    const samples: { length: number; status: string | null }[] = []
    const record = (): void => {
      const articles = document.querySelectorAll('article[data-role="agent"]')
      const last = articles[articles.length - 1]
      if (last === undefined) {
        return
      }
      const status = document.querySelector('[role="status"][aria-label^="Status: "]')
      samples.push({
        length: (last.textContent ?? '').length,
        status: status?.textContent ?? null,
      })
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    Object.assign(window, { __qaSamples: samples, __qaObserver: observer })
  })
}

/** What {@link recordRendering} saw so far, oldest first. */
export async function renderingSamples(page: Page): Promise<GrowthSample[]> {
  return page.evaluate(() => (window as unknown as { __qaSamples: GrowthSample[] }).__qaSamples)
}

/** The distinct lengths the live reply was rendered at, in order. */
export async function renderedLengths(page: Page): Promise<number[]> {
  return (await renderingSamples(page)).map((sample) => sample.length)
}

/** Whether the header ever painted this status label. */
export async function sawStatus(page: Page, label: string): Promise<boolean> {
  return (await renderingSamples(page)).some((sample) => sample.status === label)
}
