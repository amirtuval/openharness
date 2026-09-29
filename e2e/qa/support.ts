import path from 'node:path'

import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Shared helpers for the #14 QA pass: the base URL, the console-error collector, screenshots
 * and a thin wrapper over the HTTP API for setup and for assertions that are about the log
 * rather than the pixels.
 */

/** Where the app under test lives. Same default as `playwright.config.ts`. */
export const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3000'

/** Where screenshots land. Relative paths resolve against the `e2e` package folder. */
const SHOT_DIR = process.env.QA_SHOT_DIR ?? 'qa-output'

/** The API key the server under test expects, when it was started with one. */
export const API_KEY = process.env.QA_API_KEY ?? ''

/** A name that no earlier run can collide with. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`
}

/** The `x-api-key` header the server under test needs, or nothing when it is open. */
export function authHeaders(): Record<string, string> {
  return API_KEY === '' ? {} : { 'x-api-key': API_KEY }
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

// --- a thin client for the HTTP API -----------------------------------------------------------------

/** Create an agent and answer it. Throws with the server's envelope when it says no. */
export async function createAgent(
  request: APIRequestContext,
  values: { name: string; model: string; system: string },
): Promise<{ id: string; name: string }> {
  const response = await request.post('/v1/agents', {
    headers: authHeaders(),
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
    headers: authHeaders(),
    data: { agent: agentId },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as { id: string }
}

/** Read one session. */
export async function getSession(
  request: APIRequestContext,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(`/v1/sessions/${sessionId}`, { headers: authHeaders() })
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
    headers: authHeaders(),
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
      headers: authHeaders(),
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

/** Every message on screen, oldest first, as `role:text`. */
export async function transcript(page: Page): Promise<string[]> {
  return page
    .locator('article[data-role]')
    .evaluateAll((nodes) =>
      nodes.map((node) => `${node.getAttribute('data-role') ?? '?'}:${node.textContent ?? ''}`),
    )
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
