import { afterEach, describe, expect, it } from 'vitest'
import {
  EVENT_TYPES,
  type AgentMessageEvent,
  type ModelRequestEndEvent,
  type SessionId,
  type StoredEvent,
  partitionOf,
} from '@openharness/protocol'
import { FencedError, InMemorySessionStore } from '@openharness/session'

import { SessionRunner } from './runner'
import { TEST_OWNER_ID } from './test-support'
import { LocalScheduler } from './scheduler'
import {
  createScriptedModel,
  createTestApp,
  readHistory,
  resolveTestSessionCredential,
  waitFor,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * The scheduling rules, driven through a store the test controls directly: one turn per
 * session at a time, steering, interrupts, recovery, and the fence #11 will use.
 *
 * The model is scripted per request and can act between two chunks, which is the only way to
 * send a steering message or an interrupt *during* a request rather than before or after it.
 */

let context: TestContext | undefined

afterEach(async () => {
  await context?.close()
  context = undefined
})

/** Create an agent and a session straight in the store, without the HTTP layer. */
async function fixture(
  options: Parameters<typeof createTestApp>[0] = {},
): Promise<{ context: TestContext; sessionId: SessionId }> {
  const test = createTestApp(options)
  context = test
  const agent = await test.store.createAgent(
    { name: 'Agent', model: { id: 'test/model' } },
    TEST_OWNER_ID,
  )
  const session = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
  return { context: test, sessionId: session.id }
}

/** Append a `user.message` and tell the scheduler about it, as the route does. */
async function send(test: TestContext, sessionId: SessionId, text: string): Promise<void> {
  await test.store.appendEvents(sessionId, [
    { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] },
  ])
  test.scheduler.signal(sessionId, 'work')
}

/** Append a `user.interrupt` and tell the scheduler about it, as the route does. */
async function interrupt(test: TestContext, sessionId: SessionId): Promise<void> {
  await test.store.appendEvents(sessionId, [{ type: EVENT_TYPES.userInterrupt }])
  test.scheduler.signal(sessionId, 'interrupt')
}

/** The agent replies in a log, as the text they carry. */
function repliesOf(events: readonly StoredEvent[]): string[] {
  return events.flatMap((event) => (event.type === EVENT_TYPES.agentMessage ? [textOf(event)] : []))
}

/** The text one agent message carries. */
function textOf(event: AgentMessageEvent): string {
  return event.content.map((block) => block.text).join('')
}

describe('running a session', () => {
  it('runs a turn for a queued message and ends idle', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['Hello there'] }] })

    await send(test, sessionId, 'Hi')

    await waitForIdle(test.store, sessionId)
    const history = await readHistory(test.store, sessionId)
    expect(history.map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(repliesOf(history)).toEqual(['Hello there'])
  })

  it('does nothing for a session with no work, and does not spin', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['never'] }] })

    test.scheduler.signal(sessionId, 'work')

    await waitForIdle(test.store, sessionId)
    expect(test.model.requests).toBe(0)
    expect(await readHistory(test.store, sessionId)).toEqual([])
  })
})

/** An `InMemorySessionStore` whose turn-state read runs a hook, once. */
class WakingStore extends InMemorySessionStore {
  onTurnStateRead: (() => Promise<void> | void) | undefined

  override async getTurnState(
    sessionId: SessionId,
  ): ReturnType<InMemorySessionStore['getTurnState']> {
    const state = await super.getTurnState(sessionId)
    const hook = this.onTurnStateRead
    this.onTurnStateRead = undefined
    await hook?.()
    return state
  }
}

describe('a wake that arrives while a turn is finishing', () => {
  it('is not lost when the turn that was running had nothing to do', async () => {
    // The narrow race this guards: a `noop` turn is one that found nothing to do, but the
    // brain reads the log before it decides, so a message appended in that window is invisible
    // to it. The signal for that message wakes the pass — and a pass that stopped on `noop`
    // without looking at the flag again would leave the message queued until a restart.
    const store = new WakingStore()
    const model = createScriptedModel({ text: ['answered after the wake'] })
    const runner = new SessionRunner({
      store,
      model: model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    const agent = await store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    store.onTurnStateRead = async () => {
      await store.appendEvents(session.id, [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'appended mid-read' }] },
      ])
      runner.wake(session.id)
    }

    const outcome = await runner.run(session.id)

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(repliesOf(await readHistory(store, session.id))).toEqual(['answered after the wake'])
    expect(await store.getPendingUserEvents(session.id)).toEqual([])
  })
})

describe('one turn at a time', () => {
  it('answers a second run() call for the same session with the pass in flight', async () => {
    const { context: test, sessionId } = await fixture({
      replies: [{ text: ['slow'], delayMs: 50 }],
    })
    const runner = new SessionRunner({
      store: test.store,
      model: test.model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    await test.store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'Hi' }] },
    ])

    const first = runner.run(sessionId)
    const second = runner.run(sessionId)

    expect(second).toBe(first)
    expect(runner.isRunning(sessionId)).toBe(true)
    await first
    expect(runner.isRunning(sessionId)).toBe(false)
    expect(test.model.requests).toBe(1)
  })

  it('never has two model requests in flight for one session, even under steering', async () => {
    const test = createTestApp()
    context = test
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    let steered = false
    test.model.push({
      text: ['one ', 'two ', 'three'],
      delayMs: 10,
      onChunk: async (_chunk, index) => {
        if (index === 0 && !steered) {
          steered = true
          await send(test, session.id, 'a steering message')
        }
      },
    })

    await send(test, session.id, 'first')

    await waitForIdle(test.store, session.id)
    expect(test.model.maxConcurrent).toBe(1)
    expect(test.model.requests).toBe(2)
  })
})

describe('steering', () => {
  it('answers a message that arrived mid-request in a second request', async () => {
    const test = createTestApp()
    context = test
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    let steered = false
    test.model.push({
      text: ['first reply'],
      delayMs: 5,
      onChunk: async (_chunk, index) => {
        if (index === 0 && !steered) {
          steered = true
          await send(test, session.id, 'second message')
        }
      },
    })
    test.model.push({ text: ['second reply'] })

    await send(test, session.id, 'first message')

    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    expect(repliesOf(history)).toEqual(['first reply', 'second reply'])
    expect(test.model.prompts.at(-1)).toContain('second message')
  })
})

describe('interrupts', () => {
  it('aborts the turn in flight and keeps the partial reply', async () => {
    const { context: test, sessionId } = await fixture({
      replies: [{ text: ['Part', 'ial', ' reply'], delayMs: 10 }],
    })
    // Interrupt from the live stream, so the abort lands while a chunk is in flight — the
    // same place a real user's interrupt lands.
    await test.store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventDelta) {
        void interrupt(test, sessionId)
      }
    })

    await send(test, sessionId, 'please talk a lot')

    await waitForIdle(test.store, sessionId)
    const history = await readHistory(test.store, sessionId)
    const spanEnd = history.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.error?.type).toBe('interrupted')
    expect(spanEnd?.is_error).toBe(true)
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
    // The partial reply is a prefix of what the model would have produced, and the interrupt
    // that cut it short is marked processed.
    const partial = repliesOf(history).join('')
    expect(partial.length).toBeGreaterThan(0)
    expect('Partial reply'.startsWith(partial)).toBe(true)
    const interruptEvent = history.find((event) => event.type === EVENT_TYPES.userInterrupt)
    expect(interruptEvent?.processed_at).not.toBeNull()
  })

  it('runs the brain even when nothing is running, so a queued interrupt is claimed', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['unused'] }] })

    await interrupt(test, sessionId)

    await waitForIdle(test.store, sessionId)
    const history = await readHistory(test.store, sessionId)
    // The interrupt is claimed by the `session.status_idle` that ends the turn (P4): nothing
    // was in flight, no model request is opened for an interrupt, and the claim is what keeps
    // the interrupt from being reached twice.
    expect(history.map((event) => event.type)).toEqual([
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(history[2]).toMatchObject({ consumes: [history[0]?.id] })
    expect(history[0]?.processed_at).not.toBeNull()
    // Nothing was asked of the model: there was no message to answer.
    expect(test.model.requests).toBe(0)
  })

  it('runs a message that was queued behind an interrupt', async () => {
    const { context: test, sessionId } = await fixture({
      replies: [{ text: ['long ', 'slow ', 'reply'], delayMs: 15 }],
    })
    test.model.push({ text: ['the answer to the queued message'] })
    let interrupted = false
    await test.store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventDelta && !interrupted) {
        interrupted = true
        // The interrupt first, then the message it queued behind — the order the API
        // produces for a user who hits stop and then types again.
        void (async () => {
          await interrupt(test, sessionId)
          await send(test, sessionId, 'queued behind the interrupt')
        })()
      }
    })

    await send(test, sessionId, 'start something long')

    await waitForIdle(test.store, sessionId)
    const history = await readHistory(test.store, sessionId)
    expect(repliesOf(history).at(-1)).toContain('the answer to the queued message')
    expect(test.model.requests).toBe(2)
    await expect(test.store.getPendingUserEvents(sessionId)).resolves.toEqual([])
  })
})

describe('recovery on start', () => {
  it('finishes a turn a dead process left open', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['recovered'] }] })
    // Exactly what a killed process leaves behind: an open turn with a model request in
    // flight and a message nobody has answered.
    await test.store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hello' }] },
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.modelRequestStart },
    ])
    expect((await test.store.getTurnState(sessionId)).state).toBe('running')

    await test.scheduler.start()
    await waitForIdle(test.store, sessionId)

    const history = await readHistory(test.store, sessionId)
    const spanEnds = history.filter(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    // The orphaned span is closed as `brain_lost`, and the turn runs again to answer.
    expect(spanEnds[0]?.error?.type).toBe('brain_lost')
    expect(spanEnds[1]?.error).toBeUndefined()
    expect(repliesOf(history)).toEqual(['recovered'])
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('picks up a queued message nobody signalled', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['found it'] }] })
    // No signal was ever sent for this: recovery is a read of the log, not a replay of
    // signals (see `@openharness/session`, "Signals are hints").
    await test.store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'queued' }] },
    ])

    await test.scheduler.start()

    await waitForIdle(test.store, sessionId)
    expect(repliesOf(await readHistory(test.store, sessionId))).toEqual(['found it'])
  })
})

describe('concurrency', () => {
  it('runs at most maxConcurrentSessions at once', async () => {
    const test = createTestApp({ maxConcurrentSessions: 1 })
    context = test
    test.model.push({ text: ['reply'], delayMs: 30 })
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const first = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    const second = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })

    await send(test, first.id, 'one')
    await send(test, second.id, 'two')

    await waitForIdle(test.store, first.id)
    await waitForIdle(test.store, second.id)
    expect(test.model.maxConcurrent).toBe(1)
    expect(test.model.requests).toBe(2)
  })

  it('runs different sessions at the same time when the limit allows it', async () => {
    const test = createTestApp({ maxConcurrentSessions: 4 })
    context = test
    test.model.push({ text: ['reply'], delayMs: 30 })
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const first = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    const second = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })

    await send(test, first.id, 'one')
    await send(test, second.id, 'two')

    await waitForIdle(test.store, first.id)
    await waitForIdle(test.store, second.id)
    expect(test.model.maxConcurrent).toBe(2)
  })
})

describe('stopping', () => {
  it('aborts the turns in flight and drains them', async () => {
    const test = createTestApp({ drainTimeoutMs: 2000 })
    context = test
    test.model.push({ text: ['one ', 'two ', 'three', ' four'], delayMs: 40 })
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })

    await send(test, session.id, 'start')
    await test.model.waitForRequests(1)

    await test.scheduler.stop()

    const history = await readHistory(test.store, session.id)
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
    expect((await test.store.getTurnState(session.id)).state).toBe('idle')
  })

  it('refuses new work once it is stopped', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['never'] }] })
    await test.scheduler.stop()

    test.scheduler.signal(sessionId, 'work')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(test.model.requests).toBe(0)
  })
})

describe('the fence', () => {
  it('reaches the store, so a turn without the partition lease writes nothing', async () => {
    const test = createTestApp({ replies: [{ text: ['never written'] }] })
    context = test
    const runner = new SessionRunner({
      store: test.store,
      model: test.model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    await test.store.appendEvents(session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hello' }] },
    ])

    // Epoch 1 was never handed out: no lease was ever acquired on this partition.
    const promised = runner.run(session.id, {
      fence: { partition: partitionOf(session.id), epoch: 1 },
    })

    await expect(promised).rejects.toThrow(FencedError)
    expect(await readHistory(test.store, session.id)).toHaveLength(1)
  })

  it('lets a turn through under the lease its owner holds', async () => {
    const test = createTestApp({ replies: [{ text: ['written'] }] })
    context = test
    const runner = new SessionRunner({
      store: test.store,
      model: test.model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    const agent = await test.store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await test.store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    await test.store.appendEvents(session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hello' }] },
    ])
    const partition = partitionOf(session.id)
    const lease = await test.store.acquirePartition(partition, 'instance-1', 60_000)
    expect(lease).not.toBeNull()

    await runner.run(session.id, { fence: { partition, epoch: lease?.epoch ?? 0 } })

    expect(repliesOf(await readHistory(test.store, session.id))).toEqual(['written'])
  })
})

describe('an external signal', () => {
  it('stops the pass without writing anything, and without losing the work', async () => {
    const { context: test, sessionId } = await fixture({ replies: [{ text: ['never'] }] })
    const runner = new SessionRunner({
      store: test.store,
      model: test.model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    await test.store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hello' }] },
    ])
    const controller = new AbortController()
    controller.abort()

    const outcome = await runner.run(sessionId, { signal: controller.signal })

    expect(outcome).toEqual({ outcome: 'noop' })
    expect(test.model.requests).toBe(0)
    expect(await readHistory(test.store, sessionId)).toHaveLength(1)
    // Nothing was lost: the message is still queued for whoever runs the session next.
    expect(await test.store.getPendingUserEvents(sessionId)).toHaveLength(1)
    expect(runner.isRunning(sessionId)).toBe(false)
  })
})

describe('the runner', () => {
  it('is a plain object a scheduler can share', async () => {
    const store = new InMemorySessionStore()
    const model = createScriptedModel({ text: ['hi'] })
    const runner = new SessionRunner({
      store,
      model: model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    const scheduler = new LocalScheduler({
      store,
      model: model.factory,
      resolveCredential: resolveTestSessionCredential,
      runner,
    })

    expect(scheduler.runner).toBe(runner)
    await scheduler.stop()
    await waitFor(() => runner.stopped)
  })
})
