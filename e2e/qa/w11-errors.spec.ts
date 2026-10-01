import { execFileSync } from 'node:child_process'

import type { APIRequestContext, Page } from '@playwright/test'

import {
  BASE_URL,
  QA_MODEL,
  SERVER_CONTAINER,
  composeServer,
  composer,
  createAgent,
  createSession,
  eventTypes,
  expect,
  isRealModel,
  openChat,
  readEvents,
  recordRendering,
  sawStatus,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
  waitForAnswer,
  waitForHealth,
} from './support'

/**
 * Recreate the server container with a different environment.
 *
 * Changing a service's environment is what makes compose recreate it; `stop`/`start` would
 * leave the process holding the old one. What the scenarios below change is the **vault's
 * master key** (`OPENHARNESS_SECRETS_KEY`, A5): nothing reads a provider key from the
 * environment any more, so the environment is only where a deployment's own secrets live.
 */
function restartServerWith(env: { readonly OPENHARNESS_SECRETS_KEY: string }): void {
  composeServer(env, 'up', '-d', 'server')
}

/**
 * `<model requests so far>:<last status>`, for waiting on a turn without racing it.
 *
 * A session that has just failed reads `idle` before the next message's turn has even started,
 * so "the session is idle" is not on its own evidence that a message was answered.
 */
async function turnSummary(request: APIRequestContext, sessionId: string): Promise<string> {
  const types = await eventTypes(request, sessionId)
  const requests = types.filter((type) => type === 'span.model_request_start').length
  return `${String(requests)}:${types.at(-1) ?? 'none'}`
}

/** Send a message and answer whether the reply turned up, without failing if it did not. */
async function sendAndWaitForReply(page: Page, text: string): Promise<boolean> {
  await sendFromComposer(page, text)
  try {
    await waitForAnswer(page, text, { timeoutMs: 30_000 })
    return true
  } catch {
    return false
  }
}

/** The provider the pass has a key for, and the model whose provider it has none for (A5). */
const QA_PROVIDER = process.env.QA_PROVIDER ?? 'openai'
const QA_PROVIDER_KEY = process.env.QA_PROVIDER_KEY ?? ''
const QA_MISSING_MODEL = process.env.QA_MISSING_MODEL ?? 'groq/llama-3.3-70b-versatile'

/** W11 — failures: a retry, a terminal error, and a server that is not there. */
test.describe('W11 errors', () => {
  test('W11a a retryable failure shows the retry and then succeeds', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(isRealModel, 'the failure is scripted by the mock model (`__fail_retryable__`)')
    const agent = await createAgent(request, {
      name: uniqueName('QA W11a'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await recordRendering(page)

    // The prompt carries a per-run suffix: the mock counts attempts **per prompt text**, and
    // lives as long as the server process — so without it a second pass against the same
    // running stack sends a prompt the model has already failed once, and the retry this
    // scenario is about never happens (`apps/server/src/mock-model.ts`, `AttemptCounter`).
    await sendFromComposer(page, `__fail_retryable__ please answer anyway ${uniqueName('pass')}`)

    await expect(page.locator('article[data-role="agent"]').last()).toContainText(
      'please answer anyway',
    )
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(
      await sawStatus(page, 'Retrying'),
      'the header painted "Retrying" while the failure was being retried',
    ).toBe(true)

    const log = await eventTypes(request, session.id)
    expect(log).toContain('session.error')
    expect(log).toContain('session.status_rescheduled')
    expect(log.indexOf('session.status_rescheduled')).toBeLessThan(log.indexOf('agent.message'))
    await shot(page, 'w11-01-after-retry')

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('W11b a terminal failure is shown inline and the composer still works', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(isRealModel, 'the failure is scripted by the mock model (`__fail_terminal__`)')
    const agent = await createAgent(request, {
      name: uniqueName('QA W11b'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    await sendFromComposer(page, '__fail_terminal__ this cannot work')

    const banner = page.getByRole('alert')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('model_request_failed_error')
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    await shot(page, 'w11-02-terminal-error')

    await test.step('the composer still works', async () => {
      await expect(composer(page)).toBeEnabled()
      await sendFromComposer(page, 'and now something that works')
      await expect(page.locator('article[data-role="agent"]').last()).toContainText(
        'and now something that works',
      )
      await expect(banner).toHaveCount(0)
    })

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  // Stopping the container is not something `yarn qa:web` should do to a stranger's server,
  // so this one runs only when it is asked for.
  test('W11c a stopped server is reported, and a restart recovers', async ({
    page,
    request,
    consoleErrors,
  }) => {
    test.skip(
      process.env.QA_ALLOW_SERVER_RESTART !== '1',
      'set QA_ALLOW_SERVER_RESTART=1 to stop and start the server container',
    )

    // The message the chat shows can only name the server if the app was told which server it
    // is: with no URL saved it says "this site", which is true and is not what this scenario is
    // about. An absolute URL here is the same origin the page is already on.
    await test.step('point the app at the server by URL', async () => {
      await page.goto('/#/settings')
      await page.getByLabel('Server URL').fill(BASE_URL)
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible()
    })

    const agent = await createAgent(request, {
      name: uniqueName('QA W11c'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await sendFromComposer(page, 'before the outage')
    await waitForAnswer(page, 'before the outage')
    // A real model's reply starts arriving long before its turn is over; this scenario needs
    // the session at rest before the server goes away, so that the next message is a new turn
    // rather than a steering one.
    await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

    try {
      execFileSync('docker', ['stop', SERVER_CONTAINER], { stdio: 'pipe' })
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')

      await sendFromComposer(page, 'while the server is down')
      const banner = page.getByRole('alert')
      await expect(banner).toBeVisible({ timeout: 30_000 })
      await shot(page, 'w11-03-server-down')

      // Regression coverage for issue #28: the banner used to be the browser's own
      // "Request failed / Failed to fetch". Fixed by PR #33, which classifies the transport
      // failure and names the server the app was pointed at (`apps/web/src/lib/errors.ts`).
      const text = await banner.innerText()
      console.log('banner while the server was down:', text)
      expect(text, 'the browser’s own words for it are not reported to the user').not.toContain(
        'Failed to fetch',
      )
      expect(text, 'the banner names the server that could not be reached').toContain(BASE_URL)
    } finally {
      execFileSync('docker', ['start', SERVER_CONTAINER], { stdio: 'pipe' })
    }

    await test.step('the app recovers after the server comes back', async () => {
      await waitForHealth()

      // Does the open tab pick the session up again on its own?
      const recoveredByItself = await sendAndWaitForReply(page, 'after the outage')
      console.log('the open tab recovered without a reload:', recoveredByItself)

      await page.reload()
      await expect(page.locator('article[data-role="user"]').last()).toContainText(
        'after the outage',
      )
      await sendFromComposer(page, 'and after the reload')
      await waitForAnswer(page, 'and after the reload')
      await expect(page.getByRole('alert')).toHaveCount(0)
      await shot(page, 'w11-04-recovered')
    })

    // This is the one scenario where the browser is *meant* to shout about the network.
    const unexpected = consoleErrors.filter(
      (entry) => !/Failed to load resource|net::ERR_/.test(entry),
    )
    expect(unexpected, unexpected.join('\n')).toEqual([])
  })

  // The failures a real provider actually produces. They need the router, so the mock cannot
  // stand in for them; and they need a provider key, so the mock passes skip them.

  test('W11d an unknown model id fails the turn once and leaves the session usable', async ({
    page,
    request,
  }) => {
    test.skip(!isRealModel, 'the mock model answers whatever id an agent names')

    const agent = await createAgent(request, {
      name: uniqueName('QA W11d'),
      model: 'openai/does-not-exist-123',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await sendFromComposer(page, 'this model does not exist')

    await test.step('the app says what went wrong and goes back to idle', async () => {
      const banner = page.getByRole('alert')
      await expect(banner).toBeVisible({ timeout: 60_000 })
      await expect(banner).toContainText('does-not-exist-123')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      await shot(page, 'w11-05-unknown-model')
    })

    await test.step('the log says it failed once, terminally', async () => {
      const log = await readEvents(request, session.id)
      const types = log.map((event) => String(event.type))
      const error = log.find((event) => event.type === 'session.error')?.error as {
        type: string
        message: string
        retry_status: { type: string }
      }
      expect(error.type).toBe('model_request_failed_error')
      expect(error.message, 'the message names the model that could not be found').toContain(
        'does-not-exist-123',
      )
      expect(error.retry_status.type, 'a bad model id is not worth retrying').toBe('terminal')
      expect(
        types.filter((type) => type === 'span.model_request_start'),
        'asked the provider once, not three times',
      ).toHaveLength(1)
      expect(types, 'nothing was rescheduled').not.toContain('session.status_rescheduled')
      expect(types.at(-1), 'the turn ended').toBe('session.status_idle')
    })

    await test.step('the session is not wedged', async () => {
      // The model id is part of the session's snapshot, so this turn cannot start working —
      // what is being checked is that the session accepts the next message and ends it the
      // same clean way rather than sitting in `running`.
      await sendFromComposer(page, 'and again')
      // Wait for that turn rather than for the banner: the first failure's banner is still on
      // screen, so it says nothing about whether this message has been answered yet.
      await expect
        .poll(async () => turnSummary(request, session.id), {
          timeout: 60_000,
          message: 'the second message should have started and ended a turn of its own',
        })
        .toBe('2:session.status_idle')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    })

    await test.step('the agent switched back to a model that exists answers', async () => {
      // A session keeps the agent it was created against, so "switched back" is the agent
      // itself — the same one, on a model that resolves — and a new chat on it. This is the
      // recovery an operator actually reaches for after naming a model that does not exist.
      const updated = await request.post(`/v1/agents/${agent.id}`, {
        data: { model: { id: QA_MODEL } },
      })
      expect(updated.status(), await updated.text()).toBe(200)

      const next = await createSession(request, agent.id)
      await openChat(page, next.id)
      await sendFromComposer(page, 'the model exists again')
      await waitForAnswer(page, 'the model exists again')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      await expect(page.getByRole('alert'), 'nothing failed this time').toHaveCount(0)
      await shot(page, 'w11-09-agent-switched-back')
    })
  })

  test('W11e an agent whose provider has no credential fails cleanly', async ({
    page,
    request,
  }) => {
    test.skip(!isRealModel, 'without a real router there is no provider to miss a credential for')

    // This pass stores no key for the missing provider on purpose: a missing credential has to
    // read as a missing credential (A5) — with the way out — rather than as a hang or a retry
    // storm. (`QA_MISSING_MODEL` names a provider the pass has no key for.)
    const agent = await createAgent(request, {
      name: uniqueName('QA W11e'),
      model: QA_MISSING_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await sendFromComposer(page, 'anything at all')

    await test.step('the app names the credential that is missing, and where to add it', async () => {
      const banner = page.getByRole('alert')
      await expect(banner).toBeVisible({ timeout: 60_000 })
      await expect(banner).toContainText('missing_provider_credential')
      await expect(banner).toContainText(/No .* key is set/i)
      await expect(banner.getByRole('link', { name: /Settings/ })).toHaveAttribute(
        'href',
        '#/settings',
      )
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      await shot(page, 'w11-06-missing-credential')
    })

    await test.step('the log says it failed once, and never retried', async () => {
      const log = await readEvents(request, session.id)
      const types = log.map((event) => String(event.type))
      const error = log.find((event) => event.type === 'session.error')?.error as {
        type: string
        message: string
        retry_status: { type: string }
      }
      expect(error.type).toBe('missing_provider_credential')
      // The protocol's rule for this type: it is never retried, so its retry status is
      // `exhausted` — not the `terminal` a provider failure ends with.
      expect(error.retry_status.type, 'a missing key is not worth retrying').toBe('exhausted')
      expect(error.message).toMatch(/No .* key is set/i)
      expect(
        types.filter((type) => type === 'span.model_request_start'),
        'a request with no key is never made',
      ).toHaveLength(0)
      expect(types).not.toContain('session.status_rescheduled')
      expect(types.at(-1)).toBe('session.status_idle')
    })

    await test.step('the session is not wedged', async () => {
      await sendFromComposer(page, 'and once more')
      await expect
        .poll(async () => turnSummary(request, session.id), {
          timeout: 60_000,
          message: 'the second message should have started and ended a turn of its own',
        })
        .toBe('0:session.status_idle')
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
    })
  })

  test('W11f a credential the vault cannot open fails closed, and the key recovers it', async ({
    page,
    request,
  }) => {
    test.skip(!isRealModel, 'the mock model needs no credential, so none can fail to open')
    test.skip(
      QA_PROVIDER_KEY === '',
      'set QA_PROVIDER (and QA_PROVIDER_KEY) so the scenario has a credential to break',
    )
    test.skip(
      process.env.QA_ALLOW_SERVER_RESTART !== '1',
      'set QA_ALLOW_SERVER_RESTART=1 to recreate the server container',
    )

    const agent = await createAgent(request, {
      name: uniqueName('QA W11f'),
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)

    // Store a working key first (the PUT validates it against the provider, A5).
    const stored = await request.put(`/v1/provider-credentials/${QA_PROVIDER}`, {
      data: { type: 'api_key', api_key: QA_PROVIDER_KEY },
    })
    expect(stored.status(), await stored.text()).toBe(200)

    try {
      await test.step('the master key is rotated to one nothing was sealed with', async () => {
        restartServerWith({
          OPENHARNESS_SECRETS_KEY: Buffer.from(
            'qa-rotated-master-key-32-bytes-ope',
            'utf8',
          ).toString('base64'),
        })
        await waitForHealth()
      })

      await test.step('the turn fails closed, naming the missing credential', async () => {
        await openChat(page, session.id)
        await sendFromComposer(page, 'with a credential the vault cannot open')

        // A key that cannot be opened is a *missing* credential: the turn ends before any
        // request, and the row is still there to be fixed rather than silently ignored.
        const banner = page.getByRole('alert')
        await expect(banner).toBeVisible({ timeout: 60_000 })
        await expect(banner).toContainText('missing_provider_credential')
        await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
        await shot(page, 'w11-07-key-that-does-not-open')

        const types = await eventTypes(request, session.id)
        expect(types.filter((type) => type === 'span.model_request_start')).toHaveLength(0)
        expect(types.at(-1)).toBe('session.status_idle')
      })
    } finally {
      // Whatever happened above, put the stack's own master key back: every scenario after
      // this one runs against the same server.
      restartServerWith({
        OPENHARNESS_SECRETS_KEY: process.env.OPENHARNESS_SECRETS_KEY ?? '',
      })
      await waitForHealth()
    }

    await test.step('the same session works once the vault can open the key again', async () => {
      await sendFromComposer(page, 'and now with the key that opens')
      await waitForAnswer(page, 'and now with the key that opens', { timeoutMs: 90_000 })
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      await expect(page.getByRole('alert'), 'the error is gone').toHaveCount(0)
      await shot(page, 'w11-08-key-restored')
    })
  })
})
