import { ApiError, AuthenticationError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { describe, expect, it } from 'vitest'

import { failing } from '../test-support/fake'
import { waitFor } from '../test-support/input'
import { createChatSession, type ChatSession } from './session'

/** The chat's text, in order, as the transcript holds it. */
function textsOf(session: ChatSession): readonly string[] {
  return session.getState().transcript.messages.map((message) => message.text)
}

/** The agent messages, which is what the streaming assertions are about. */
function agentTexts(session: ChatSession): readonly string[] {
  return session
    .getState()
    .transcript.messages.filter((message) => message.role === 'agent')
    .map((message) => message.text)
}

/**
 * Wait for the transcript to read exactly this.
 *
 * The transcript is fed by a stream, so the last event of a turn arrives a tick after the
 * turn ends — `fake.waitForIdle()` says the brain is done, not that the client has caught up.
 */
async function waitForTexts(session: ChatSession, expected: readonly string[]): Promise<void> {
  await waitFor(() => JSON.stringify(textsOf(session)) === JSON.stringify(expected), {
    describe: () => `expected ${JSON.stringify(expected)}, got ${JSON.stringify(textsOf(session))}`,
  })
}

describe('createChatSession', () => {
  it('loads the history of the session it resumes', async () => {
    const fake = createFakeClient()
    fake.respondWith('Hello, this is history.')
    await fake.sendMessage(fake.session.id, 'A message from before.')
    await fake.waitForIdle()

    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    expect(textsOf(session)).toEqual(['A message from before.', 'Hello, this is history.'])
    expect(session.getState().phase).toBe('ready')
    session.dispose()
  })

  it('streams a reply to a message it sends', async () => {
    const fake = createFakeClient()
    fake.respondWith('A streamed reply.', { chunks: 4 })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await session.send('Hello there.')
    await fake.waitForIdle()
    await waitForTexts(session, ['Hello there.', 'A streamed reply.'])

    expect(session.getState().transcript.status).toBe('idle')
    session.dispose()
  })

  it('marks the message it sends as pending until the brain picks it up', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('Slow reply.', { chunks: 4, delayMs: 20 })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await session.send('Queued up.')
    await waitFor(() => session.getState().transcript.messages.length > 0)

    const [first] = session.getState().transcript.messages
    expect(first).toMatchObject({ role: 'user', pending: true })

    await fake.waitForIdle()
    expect(session.getState().transcript.messages[0]?.pending).toBe(false)
    session.dispose()
  })

  it('steers a running turn: the queued message is taken up in the same turn', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('First reply.', { chunks: 4, delayMs: 25 })
    fake.respondWith('Second reply.', { chunks: 4, delayMs: 25 })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await session.send('One.')
    await waitFor(() => session.getState().transcript.status === 'running')

    // While the first reply is still arriving.
    await session.send('Two.')
    await fake.waitForIdle()

    await waitForTexts(session, ['One.', 'First reply.', 'Two.', 'Second reply.'])
    session.dispose()
  })

  it('interrupts a running turn and keeps the partial reply', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('One two three four five six', { chunks: 6, delayMs: 30 })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await session.send('Go.')
    await waitFor(() => agentTexts(session).some((text) => text.length > 0))

    expect(session.pressCtrlC()).toBe('interrupt')
    await fake.waitForIdle()
    await waitFor(() => session.getState().transcript.status === 'idle')

    const partial = agentTexts(session)[0] ?? ''
    expect(partial.length).toBeGreaterThan(0)
    expect('One two three four five six'.startsWith(partial)).toBe(true)
    expect(partial).not.toBe('One two three four five six')
    session.dispose()
  })

  it('does not interrupt when nothing is running', async () => {
    const fake = createFakeClient()
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    expect(session.pressCtrlC()).toBe('arm')
    expect(session.getState().notice?.kind).toBe('hint')

    session.dispose()
  })

  it('exits on the second idle Ctrl+C, and only inside the window', async () => {
    const fake = createFakeClient()
    let now = 1000
    const session = createChatSession({ client: fake, session: fake.session, now: () => now })
    await session.start()

    expect(session.pressCtrlC()).toBe('arm')
    now = 1000 + 60_000
    expect(session.pressCtrlC()).toBe('arm')
    now = 1000 + 60_000 + 100
    expect(session.pressCtrlC()).toBe('exit')
    expect(session.getState().notice).toBeNull()
    session.dispose()
  })

  it('drops the exit hint as soon as the user types', () => {
    const fake = createFakeClient()
    const session = createChatSession({ client: fake, session: fake.session })

    session.pressCtrlC()
    expect(session.getState().notice).not.toBeNull()

    session.dismissHint()
    expect(session.getState().notice).toBeNull()
    session.dispose()
  })

  it('shows a failed send as an inline notice', async () => {
    const fake = createFakeClient()
    const client = failing(fake, 'sendMessage', new AuthenticationError('Not signed in.'))
    const session = createChatSession({
      client,
      session: fake.session,
      context: { server: 'http://localhost:3000' },
    })
    await session.start()

    await session.send('Hello.')

    const notice = session.getState().notice
    expect(notice?.kind).toBe('error')
    expect(notice?.text).toContain('not signed in to http://localhost:3000')
    expect(notice?.text).toContain('oh login')
    session.dispose()
  })

  it('shows a server failure as an inline notice', async () => {
    const fake = createFakeClient()
    const client = failing(fake, 'sendMessage', new ApiError(500, 'boom'))
    const session = createChatSession({ client, session: fake.session, context: {} })
    await session.start()

    await session.send('Hello.')

    expect(session.getState().notice?.text).toContain('boom')
    session.dispose()
  })

  it('shows a failed interrupt as an inline notice', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('Something long enough to interrupt.', { chunks: 8, delayMs: 20 })
    const client = failing(fake, 'interrupt', new ApiError(500, 'boom'))
    const session = createChatSession({ client, session: fake.session })
    await session.start()

    await session.send('Go.')
    await waitFor(() => session.getState().transcript.status === 'running')

    await session.interrupt()
    expect(session.getState().notice?.kind).toBe('error')

    await fake.waitForIdle()
    session.dispose()
  })

  it('stops following the log once disposed', async () => {
    const fake = createFakeClient()
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()
    session.dispose()

    expect(session.getState().phase).toBe('closed')

    fake.respondWith('Too late.')
    await fake.sendMessage(fake.session.id, 'Sent after the UI was gone.')
    await fake.waitForIdle()

    expect(textsOf(session)).toEqual([])
    expect(() => {
      session.dispose()
    }).not.toThrow()
  })

  it('notifies subscribers of every change', async () => {
    const fake = createFakeClient()
    fake.respondWith('A reply.')
    const session = createChatSession({ client: fake, session: fake.session })
    const seen: number[] = []
    const unsubscribe = session.subscribe((state) => seen.push(state.transcript.messages.length))

    await session.start()
    await session.send('Hello.')
    await fake.waitForIdle()

    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(2)

    unsubscribe()
    const before = seen.length
    await session.send('Another.')
    await fake.waitForIdle()
    expect(seen.length).toBe(before)
    session.dispose()
  })
})
