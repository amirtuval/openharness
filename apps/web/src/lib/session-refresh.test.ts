import type { Client } from '@openharness/client'
import { describe, expect, it, vi } from 'vitest'

import { makeFake } from '../test-support/render-app'
import { sessionRefresh, withFreshSessions } from './session-refresh'

/**
 * The store behind the title that arrives without a reload (#35): one read per session, one
 * surface for both callers — the sidebar's list and the open chat's header.
 */
describe('sessionRefresh', () => {
  it('hands the same store to every caller of one client', () => {
    const fake = makeFake()

    expect(sessionRefresh(fake)).toBe(sessionRefresh(fake))
    expect(sessionRefresh(fake)).not.toBe(sessionRefresh(makeFake()))
  })

  it('reads a session once, however often it is asked', async () => {
    const fake = makeFake()
    const reads = countReads(fake)
    const store = sessionRefresh(fake)

    // Three asks in a row — a message, a steering message, a re-render — are one request.
    store.refresh(fake.session.id)
    store.refresh(fake.session.id)
    store.refresh(fake.session.id)
    await vi.waitFor(() => {
      expect(store.sessions.get(fake.session.id)).not.toBeUndefined()
    })

    expect(reads()).toBe(1)

    // And an answered read is never repeated, title or no title: this store does not poll.
    store.refresh(fake.session.id)
    store.refresh(fake.session.id)
    await Promise.resolve()
    expect(reads()).toBe(1)
  })

  it('publishes the re-read session to its subscribers', async () => {
    const fake = makeFake()
    const store = sessionRefresh(fake)
    const seen: number[] = []
    const unsubscribe = store.subscribe(() => {
      seen.push(store.sessions.size)
    })

    store.refresh(fake.session.id)
    await vi.waitFor(() => {
      expect(store.sessions.get(fake.session.id)).not.toBeUndefined()
    })

    expect(seen).toEqual([1])
    unsubscribe()
  })

  it('leaves a session open for a later read when the read fails', async () => {
    const fake = makeFake()
    const reads = countReads(fake, () => Promise.reject(new Error('no answer')))
    const store = sessionRefresh(fake)

    store.refresh(fake.session.id)
    await vi.waitFor(() => {
      expect(reads()).toBe(1)
    })
    // Nothing to show and nothing to remember: the read failed, so the chat is exactly as it
    // was — and the next ask is allowed to try again.
    expect(store.sessions.size).toBe(0)

    store.refresh(fake.session.id)
    await vi.waitFor(() => {
      expect(reads()).toBe(2)
    })
  })
})

describe('withFreshSessions', () => {
  it('replaces the sessions that were re-read, and only those', async () => {
    const fake = makeFake()
    const store = sessionRefresh(fake)
    store.refresh(fake.session.id)
    await vi.waitFor(() => {
      expect(store.sessions.size).toBe(1)
    })

    const other = await fake.sessions.create({ agent: fake.agent.id })
    const listed = [fake.session, other]
    const merged = withFreshSessions(listed, store.sessions)

    expect(merged).toHaveLength(2)
    expect(merged[0]?.id).toBe(fake.session.id)
    expect(merged[1]).toBe(other)
  })

  it('hands the list back untouched when nothing has been re-read', () => {
    const fake = makeFake()
    const listed = [fake.session]

    // Same array, so a sidebar that has nothing new to show does not re-render its rows.
    expect(withFreshSessions(listed, sessionRefresh(fake).sessions)).toBe(listed)
  })
})

/** Count the `sessions.get` calls a fake answers, with an optional stand-in read. */
function countReads(
  fake: ReturnType<typeof makeFake>,
  read?: Client['sessions']['get'],
): () => number {
  let count = 0
  const original = fake.sessions.get.bind(fake.sessions)
  fake.sessions.get = (sessionId, options) => {
    count += 1
    return (read ?? original)(sessionId, options)
  }
  return () => count
}
