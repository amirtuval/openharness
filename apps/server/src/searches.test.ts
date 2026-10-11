import { WEB_SEARCH_TOOL_NAME } from '@openharness/hands'
import { InMemorySessionStore } from '@openharness/session'
import { createTestClock } from '@openharness/session/testing'
import type { SessionId } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { createSearchAllowance } from './searches'

/**
 * The daily search allowance (epic #303, #305).
 *
 * What the cap counts, whose day it counts, and the boundary a user meets — on the in-memory
 * store, so the answer is the log's and not a stubbed counter's.
 */

/** A fixed instant, so which day a search fell on is the test's to choose. */
const START_MS = Date.parse('2026-10-08T12:00:00.000Z')

/** One whole day, for the tests that step over midnight. */
const DAY_MS = 86_400_000

/** A store and the session a test records searches in. */
async function harness(options: { readonly dailyLimit?: number } = {}): Promise<{
  store: InMemorySessionStore
  clock: ReturnType<typeof createTestClock>
  sessionId: SessionId
  remaining: (ownerId: string) => Promise<number>
}> {
  const clock = createTestClock(START_MS)
  const store = new InMemorySessionStore({ now: clock.now })
  const session = await store.createSession(null, { ownerId: 'user_1', model: { id: 'a/b' } })
  const allowance = createSearchAllowance({
    store,
    dailyLimit: options.dailyLimit ?? 3,
    now: clock.now,
  })
  return {
    store,
    clock,
    sessionId: session.id,
    remaining: (ownerId) => allowance.remaining(ownerId),
  }
}

/** One `web_search` call the brain made and answered, as the log holds the pair. */
async function search(
  store: InMemorySessionStore,
  sessionId: SessionId,
  options: { readonly isError?: boolean } = {},
): Promise<void> {
  const [call] = await store.appendEvents(sessionId, [
    {
      type: 'agent.tool_use',
      name: WEB_SEARCH_TOOL_NAME,
      input: { query: 'anything' },
      evaluated_permission: 'allow',
    },
  ])
  if (call === undefined) {
    throw new Error('the call was not stored')
  }
  await store.appendEvents(sessionId, [
    {
      type: 'agent.tool_result',
      tool_use_id: call.id,
      content: [{ type: 'text', text: 'results' }],
      is_error: options.isError ?? false,
    },
  ])
}

describe('createSearchAllowance', () => {
  it('answers the whole limit for a user who has not searched', async () => {
    const { remaining } = await harness({ dailyLimit: 3 })
    expect(await remaining('user_1')).toBe(3)
  })

  it('counts the searches the day has held, and stops at zero', async () => {
    const { store, sessionId, remaining } = await harness({ dailyLimit: 2 })
    await search(store, sessionId)
    expect(await remaining('user_1')).toBe(1)
    await search(store, sessionId)
    expect(await remaining('user_1')).toBe(0)
    // A refused call is stored like any other, and the count never goes below zero: the notice
    // a user sees does not change its mind about the number.
    await search(store, sessionId, { isError: true })
    expect(await remaining('user_1')).toBe(0)
  })

  it('counts the day the reader is in, not the last 24 hours', async () => {
    const { store, clock, sessionId, remaining } = await harness({ dailyLimit: 2 })
    await search(store, sessionId)
    expect(await remaining('user_1')).toBe(1)
    // Midnight UTC: yesterday's searches are yesterday's, so the allowance is whole again.
    clock.advance(DAY_MS)
    expect(await remaining('user_1')).toBe(2)
  })

  it('is one user’s day, never another’s', async () => {
    const { store, sessionId, remaining } = await harness({ dailyLimit: 2 })
    await search(store, sessionId)
    expect(await remaining('user_1')).toBe(1)
    expect(await remaining('user_2')).toBe(2)
  })

  it('answers none when the deployment allows none', async () => {
    // A limit of zero is how a deployment keeps the tool registered and switches it off.
    const { remaining } = await harness({ dailyLimit: 0 })
    expect(await remaining('user_1')).toBe(0)
  })
})
