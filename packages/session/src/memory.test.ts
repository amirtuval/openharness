import {
  EVENT_TYPES,
  StoredEventSchema,
  partitionOf,
  type SessionId,
  type StreamEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { timestampAt } from './clock'
import { FENCED_ERROR_CODE, FencedError, isFencedError } from './errors'
import { InMemorySessionStore } from './memory'
import type { AppendableEvent, SessionStore } from './store'
import { createTestClock } from './testing/clock'

/**
 * The behaviour of `InMemorySessionStore` that the conformance suite deliberately does not
 * test, because it is not part of the contract: what the fake promises on top of it — the
 * clock it takes, the copies it hands out, and the microtask its delivery happens in.
 *
 * The contract itself is tested by `testing/conformance.test.ts`.
 */

function userMessage(text: string): AppendableEvent {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** Await `work` and return what it threw; fails the test when it does not throw. */
async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw, but it resolved')
}

describe('InMemorySessionStore', () => {
  it('takes its time from the injected clock, including the ids it mints', async () => {
    const clock = createTestClock(Date.UTC(2026, 2, 15, 10, 0, 0))
    const store = new InMemorySessionStore({ now: clock.now })
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const first = await store.createSession(agent.id)
    expect(first.created_at).toBe(timestampAt(clock.currentMs))
    clock.advance(1000)
    const second = await store.createSession(agent.id)
    // ULIDs carry the millisecond they were minted at, so the ids sort by creation time too.
    expect(second.id > first.id).toBe(true)
    expect(second.created_at).toBe(timestampAt(clock.currentMs))
  })

  it('defaults to the system clock and the protocol partition count', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id)
    expect(Date.parse(session.created_at)).toBeLessThanOrEqual(Date.now())
    await store.appendEvents(session.id, [userMessage('hi')])
    expect(await store.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([session.id])
  })

  it('hashes sessions into the partition count it was given', async () => {
    const store = new InMemorySessionStore({ partitionCount: 1 })
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id)
    await store.appendEvents(session.id, [userMessage('hi')])
    expect(await store.findSessionsNeedingWork([0])).toEqual([session.id])
  })

  it('delivers in a microtask, not inside the append that published', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id)
    const received: StreamEvent[] = []
    await store.subscribe(session.id, (event) => {
      received.push(event)
    })
    void store.appendEvents(session.id, [userMessage('hi')])
    expect(received).toEqual([])
    await store.listEvents(session.id)
    expect(received).toHaveLength(1)
  })

  it('hands out copies, so a caller cannot change what the store holds', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id, { metadata: { ticket: 'OH-4' } })
    await store.appendEvents(session.id, [userMessage('hi')])

    const readBack = await store.getSession(session.id)
    if (readBack === null) {
      throw new Error('the session it just created is gone')
    }
    readBack.title = 'mutated'
    readBack.agent.name = 'mutated'
    readBack.metadata['ticket'] = 'mutated'
    const after = await store.getSession(session.id)
    expect(after?.title).toBeNull()
    expect(after?.agent.name).toBe('Summarizer')
    expect(after?.metadata).toEqual({ ticket: 'OH-4' })

    const [event] = await store.listEvents(session.id).then((page) => page.data)
    if (event === undefined) {
      throw new Error('the event it just appended is gone')
    }
    // An event is not just a copy: it is deep-frozen, because the log is immutable (D9). A
    // write to it throws rather than forking the caller's view from what the store holds —
    // and the event types are deep-readonly, so the same write is a compile error too.
    expect(Object.isFrozen(event)).toBe(true)
    expect(() => {
      Object.assign(event, { seq: 99 })
    }).toThrow(TypeError)
    expect((await store.listEvents(session.id)).data[0]?.seq).toBe(1)

    const storedAgent = await store.getAgent(agent.id)
    if (storedAgent === null) {
      throw new Error('the agent it just created is gone')
    }
    storedAgent.model.id = 'mutated'
    expect((await store.getAgent(agent.id))?.model.id).toBe('a/b')
  })

  it('returns events that carry nothing but the protocol fields', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id)
    const stored = await store.appendEvents(session.id, [userMessage('hi')])
    const [event] = stored
    expect(event).toBeDefined()
    // The store keeps a creation time internally for its own bookkeeping; `StoredEventSchema`
    // has no `created_at`, so parsing and comparing is what proves it never leaks.
    const parsed = StoredEventSchema.parse(event)
    expect(parsed).toEqual(event)
    expect(Object.keys(parsed ?? {})).not.toContain('created_at')
  })

  it('stores nothing when an append carries an event the protocol rejects', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id)
    // `content` is missing, so `StoredEventSchema` refuses the event — but the valid event in
    // front of it must not have landed either: an append is one transaction.
    const broken = { type: EVENT_TYPES.userMessage } as unknown as AppendableEvent
    const error = await thrownBy(() =>
      store.appendEvents(session.id, [userMessage('fine'), broken]),
    )
    expect(error).toBeInstanceOf(Error)
    expect((await store.listEvents(session.id)).data).toEqual([])
    expect((await store.getSession(session.id))?.updated_at).toBe(session.updated_at)
    const [stored] = await store.appendEvents(session.id, [userMessage('after')])
    expect(stored?.seq).toBe(1)
  })

  it('throws a real FencedError, which instanceof and the name/code pair both recognise', async () => {
    const clock = createTestClock()
    const store = new InMemorySessionStore({ now: clock.now })
    const agent = await store.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await store.createSession(agent.id)
    const partition = partitionOf(session.id)
    await store.acquirePartition(partition, 'owner-1', 1000)
    clock.advance(1000)

    let thrown: unknown
    try {
      await store.appendEvents(session.id, [userMessage('late')], {
        fence: { partition, epoch: 1 },
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(FencedError)
    expect(thrown).toBeInstanceOf(Error)
    expect(isFencedError(thrown)).toBe(true)
    expect(thrown).toMatchObject({
      name: 'FencedError',
      code: FENCED_ERROR_CODE,
      partition,
      epoch: 1,
      currentEpoch: 1,
      operation: 'appendEvents',
    })
    expect(String(thrown)).toContain('fenced')
  })

  it('recognises a FencedError from another copy of this package by name and code', () => {
    expect(isFencedError({ name: 'FencedError', code: FENCED_ERROR_CODE })).toBe(true)
    expect(isFencedError({ name: 'FencedError', code: 'something-else' })).toBe(false)
    expect(isFencedError(new Error('not a fence'))).toBe(false)
    expect(isFencedError('fenced')).toBe(false)
    expect(isFencedError(null)).toBe(false)
  })

  it('keeps its partitions and sessions to itself', async () => {
    const first = new InMemorySessionStore()
    const second: SessionStore = new InMemorySessionStore()
    const agent = await first.createAgent({ name: 'Summarizer', model: { id: 'a/b' } })
    const session = await first.createSession(agent.id)
    await first.appendEvents(session.id, [userMessage('hi')])
    expect(await second.getSession(session.id)).toBeNull()
    expect(await second.getAgent(agent.id)).toBeNull()
    expect(await second.findSessionsNeedingWork([partitionOf(session.id)])).toEqual([])
    const sessionId: SessionId = session.id
    expect(sessionId).toBe(session.id)
  })
})
