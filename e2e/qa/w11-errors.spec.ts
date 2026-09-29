import { execFileSync } from 'node:child_process'

import type { Page } from '@playwright/test'

import {
  BASE_URL,
  composer,
  createAgent,
  createSession,
  eventTypes,
  expect,
  openChat,
  recordRendering,
  sawStatus,
  sendFromComposer,
  shot,
  status,
  test,
  uniqueName,
} from './support'

/** The container the compose file names for the server, for the restart scenario. */
const SERVER_CONTAINER = process.env.QA_SERVER_CONTAINER ?? 'openharness-server-1'

/** Wait for the server to answer `/health` again after a restart. */
async function waitForHealth(timeoutMs = 90_000): Promise<void> {
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

/** Send a message and answer whether the reply turned up, without failing if it did not. */
async function sendAndWaitForReply(page: Page, text: string): Promise<boolean> {
  await sendFromComposer(page, text)
  try {
    await expect(page.locator('article[data-role="agent"]').last()).toContainText(text, {
      timeout: 15_000,
    })
    return true
  } catch {
    return false
  }
}

/** W11 — failures: a retry, a terminal error, and a server that is not there. */
test.describe('W11 errors', () => {
  test('W11a a retryable failure shows the retry and then succeeds', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W11a'),
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await recordRendering(page)

    await sendFromComposer(page, '__fail_retryable__ please answer anyway')

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
    const agent = await createAgent(request, {
      name: uniqueName('QA W11b'),
      model: 'anthropic/claude-sonnet-5',
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
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)
    await sendFromComposer(page, 'before the outage')
    await expect(page.locator('article[data-role="agent"]').last()).toContainText(
      'before the outage',
    )

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
      await expect(page.locator('article[data-role="agent"]').last()).toContainText(
        'and after the reload',
      )
      await expect(page.getByRole('alert')).toHaveCount(0)
      await shot(page, 'w11-04-recovered')
    })

    // This is the one scenario where the browser is *meant* to shout about the network.
    const unexpected = consoleErrors.filter(
      (entry) => !/Failed to load resource|net::ERR_/.test(entry),
    )
    expect(unexpected, unexpected.join('\n')).toEqual([])
  })
})
