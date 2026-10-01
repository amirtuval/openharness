import {
  composeServer,
  createAgent,
  createSession,
  expect,
  isRealModel,
  readEvents,
  sendMessage,
  serverContainerEnv,
  shot,
  test,
  uniqueName,
  waitForHealth,
  waitForIdle,
} from './support'

/**
 * W25 — §8 of the #74 QA pass (epic #65, A5): **environment keys are ignored**.
 *
 * The pass's one deliberate exception to "the key enters the system only through Settings →
 * Model providers": for one restart, a real `OPENAI_API_KEY` is put into the **server
 * container's environment** to prove the server does not read it — a turn on an OpenAI model
 * must still end with `missing_provider_credential`, and no model request may be made.
 *
 * Two mechanics worth knowing:
 *
 * - The stack must be the **real router**, not `OPENHARNESS_TEST_MODEL=mock` (the scenario
 *   skips unless `QA_MODEL` is set): the mock resolves a placeholder credential for every
 *   session, so a mock turn would succeed and prove nothing about a missing key.
 * - The key reaches the container only through the local compose override's
 *   `QA_ENV_KEY_FOR_S8` mapping (`OPENAI_API_KEY: ${QA_ENV_KEY_FOR_S8:-}`), which is empty
 *   unless a command exports it. This spec exports it for exactly one
 *   `up -d --force-recreate server` and removes it again right after. The key is read from the
 *   spec's own environment and is never written to a file or printed; only its length is
 *   asserted inside the container.
 *
 * It needs `QA_ALLOW_SERVER_RESTART=1` (it recreates the server) and `OPENAI_API_KEY` in the
 * environment of the test run itself.
 */

const ENV_KEY = process.env.OPENAI_API_KEY ?? ''
const MODEL = 'openai/gpt-4.1-mini'

/** The last `session.error` at or after `seq`, if the turn wrote one. */
function lastErrorAfter(events: Record<string, unknown>[], seq: number) {
  return events
    .filter((event) => event.type === 'session.error' && Number(event.seq ?? 0) > seq)
    .at(-1) as { error?: { type?: string; message?: string } } | undefined
}

test.describe('W25 §8 environment keys are ignored', () => {
  test('W25a a stored key works, a container environment key is ignored, it is removed again', async ({
    page,
    request,
  }) => {
    test.skip(ENV_KEY === '', 'set OPENAI_API_KEY in the environment to prove it is ignored')
    test.skip(
      !isRealModel,
      'the mock model resolves a placeholder credential for every session, so a mock turn cannot prove a missing key is honoured — run with QA_MODEL set',
    )

    const agent = await createAgent(request, {
      name: uniqueName('QA W25 env key'),
      model: MODEL,
      system: 'Answer in one short sentence.',
    })
    const session = await createSession(request, agent.id)

    /** Store `ENV_KEY` through Settings, the one documented door for a key. */
    const storeKey = async (): Promise<void> => {
      await page.goto('/#/settings')
      const rows = page
        .getByRole('region', { name: 'Saved provider keys' })
        .locator('[data-slot="provider-credential"]')
      await expect(page.getByText('Model providers')).toBeVisible()
      if ((await rows.filter({ hasText: 'openai' }).count()) > 0) {
        await page.getByRole('button', { name: 'Delete the openai key' }).click()
        await page.getByRole('button', { name: 'Delete', exact: true }).click()
        await expect(rows.filter({ hasText: 'openai' })).toHaveCount(0)
      }
      await page.locator('#provider-picker').selectOption('openai')
      await page.locator('#provider-api-key').fill(ENV_KEY)
      await page.getByRole('button', { name: /^(Save|Replace) key$/ }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Saved the' })).toBeVisible()
      await expect(rows.filter({ hasText: 'openai' })).toContainText(`…${ENV_KEY.slice(-4)}`)
    }

    /** Delete the stored key through Settings, with the in-page confirmation. */
    const deleteKey = async (): Promise<void> => {
      await page.goto('/#/settings')
      const rows = page
        .getByRole('region', { name: 'Saved provider keys' })
        .locator('[data-slot="provider-credential"]')
      await expect(page.getByText('Model providers')).toBeVisible()
      await page.getByRole('button', { name: 'Delete the openai key' }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Deleted the' })).toBeVisible()
      await expect(rows.filter({ hasText: 'openai' })).toHaveCount(0)
    }

    /** Recreate the server, optionally with the §8 key in its environment. */
    const restartServer = async (envKey: string): Promise<void> => {
      composeServer(
        { QA_ENV_KEY_FOR_S8: envKey },
        'up',
        '-d',
        '--force-recreate',
        '--no-deps',
        'server',
      )
      await waitForHealth()
    }

    try {
      await test.step('a stored key runs a real turn', async () => {
        await storeKey()
        const sent = await sendMessage(request, session.id, 'Reply with the single word: stored')
        await waitForIdle(request, session.id)
        const events = await readEvents(request, session.id)
        expect(
          events.some((event) => event.type === 'agent.message' && Number(event.seq ?? 0) > sent),
          'the stored key produced a reply',
        ).toBe(true)
        await shot(page, 'w25-01-stored-key-works')
      })

      await test.step('restart with the key in the container environment', async () => {
        await deleteKey()
        await restartServer(ENV_KEY)
        // The premise: the variable really is in the container's environment (compare the
        // length only — the value is never read out, logged or screenshotted).
        const inside = serverContainerEnv('OPENAI_API_KEY')
        expect(
          inside,
          'the container environment must hold the key for this scenario',
        ).not.toBeNull()
        expect(inside?.length).toBe(ENV_KEY.length)
      })

      await test.step('the turn ends with missing_provider_credential, and no request is made', async () => {
        const sent = await sendMessage(request, session.id, 'Reply with the single word: env')
        await waitForIdle(request, session.id)
        const events = await readEvents(request, session.id)
        const failure = lastErrorAfter(events, sent)
        expect(failure?.error?.type).toBe('missing_provider_credential')
        expect(failure?.error?.message).toContain('OpenAI')
        expect(failure?.error?.message).toContain('Settings → Model providers')
        // "Never used" in the strong form: the turn made no model request at all.
        expect(
          events.some(
            (event) => event.type === 'span.model_request_start' && Number(event.seq ?? 0) > sent,
          ),
          'a missing-credential turn contacts no provider',
        ).toBe(false)
        await shot(page, 'w25-02-env-key-ignored')
      })

      await test.step('restart without the key, and put the stored key back', async () => {
        await restartServer('')
        expect(serverContainerEnv('OPENAI_API_KEY') ?? '', 'the key left with the restart').toBe('')
        // The stack is left able to run OpenAI turns, which the sections after §8 need.
        await storeKey()
        await shot(page, 'w25-03-key-restored')
      })
    } finally {
      // Whatever failed, the stack must not be left with the §8 environment key.
      if ((serverContainerEnv('OPENAI_API_KEY') ?? '') !== '') {
        await restartServer('')
      }
    }
  })
})
