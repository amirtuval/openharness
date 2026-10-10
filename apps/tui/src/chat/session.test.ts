import { ApiError, AuthenticationError, type Client } from '@openharness/client'
import { createFakeClient, type FakeClient } from '@openharness/client/testing'
import { EVENT_TYPES } from '@openharness/protocol'
import { makeMode, makeModelEntry, makeProviderCredential } from '@openharness/protocol/fixtures'
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

  it('drops the exit hint on dismiss, and only the hint', () => {
    const fake = createFakeClient()
    const session = createChatSession({ client: fake, session: fake.session })

    session.pressCtrlC()
    expect(session.getState().notice?.kind).toBe('hint')

    session.dismissHint()
    expect(session.getState().notice).toBeNull()

    // An error is not a hint: the next keystroke must not sweep it away.
    session.reportError(new Error('the connection dropped'))
    session.dismissHint()
    expect(session.getState().notice?.kind).toBe('error')
    session.dispose()
  })

  it('shows a line a command wrote, and keeps it until the next message', async () => {
    const fake = createFakeClient()
    fake.respondWith('Answered.')
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    session.showNotice({ kind: 'info', text: 'Commands and keys', hints: ['/model'] })
    expect(session.getState().notice).toEqual({
      kind: 'info',
      text: 'Commands and keys',
      hints: ['/model'],
    })

    // A hint goes away when the user types; what a command printed is not a hint.
    session.dismissHint()
    expect(session.getState().notice?.text).toBe('Commands and keys')

    await session.send('Hello.')
    await fake.waitForIdle()
    expect(session.getState().notice).toBeNull()
    session.dispose()
  })

  it('sends a model picked with /model on the next message, and clears it', async () => {
    const fake = createFakeClient()
    fake.respondWith('Switched.', { sessionId: fake.session.id })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    session.setModel('openai/gpt-4.1-mini')
    expect(session.getState().pendingModel).toBe('openai/gpt-4.1-mini')

    await session.send('Now with another model.')
    await fake.waitForIdle()

    const sent = fake.history(fake.session.id).find((event) => event.type === 'user.message')
    expect(sent?.type === 'user.message' && sent.model?.id).toBe('openai/gpt-4.1-mini')
    // The choice sticks through the log, so the transcript's current model follows.
    expect(session.getState().transcript.model).toBe('openai/gpt-4.1-mini')
    // And it is not re-sent by later messages: the session runs it now.
    expect(session.getState().pendingModel).toBeNull()

    await session.send('And again.')
    await fake.waitForIdle()
    const messages = fake.history(fake.session.id).filter((event) => event.type === 'user.message')
    expect(messages[1]?.type === 'user.message' && messages[1].model).toBeUndefined()

    session.dispose()
  })

  it('leaves the transcript model alone for a message sent without a pick', async () => {
    const fake = createFakeClient()
    fake.respondWith('Hello.')
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await session.send('Plain.')
    await fake.waitForIdle()

    // The transcript only tracks what a `user.message` said (U1); a session's own model
    // stands until a message names another, which is what the status line falls back to.
    expect(session.getState().transcript.model).toBeNull()
    expect(session.getState().pendingModel).toBeNull()
    session.dispose()
  })

  it('sends a mode picked with /model on the next message, and the chat follows it (#245, M6)', async () => {
    const mode = makeMode({ name: 'smart', model: 'openai/gpt-4.1-mini' })
    const fake = createFakeClient({
      modes: [mode],
      models: [makeModelEntry({ id: 'openai/gpt-4.1-mini' })],
      credentials: [makeProviderCredential({ name: 'openai' })],
    })
    fake.respondWith('Following the mode.')
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    session.setMode(mode.id)
    expect(session.getState().pendingMode).toBe(mode.id)

    await session.send('Go deep.')
    await fake.waitForIdle()

    const sent = fake.history(fake.session.id).find((event) => event.type === 'user.message')
    expect(sent?.type === 'user.message' && sent.mode).toBe(mode.id)
    // The chat follows it from here, and the tab remembers it for the status line (the
    // transcript tracks models, not modes).
    expect(session.getState().pendingMode).toBeNull()
    expect(session.getState().modeId).toBe(mode.id)

    session.dispose()
  })

  it('detaches from a mode when a plain model is picked, and the reverse (#245, M6)', async () => {
    const mode = makeMode({ name: 'smart', model: 'openai/gpt-4.1-mini' })
    const fake = createFakeClient({
      modes: [mode],
      models: [makeModelEntry({ id: 'openai/gpt-4.1-mini' })],
      credentials: [makeProviderCredential({ name: 'openai' })],
    })
    fake.respondWith('Plain.')
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    session.setMode(mode.id)
    session.setModel('openai/gpt-4.1-mini')
    // A model pick clears the pending mode: a chat follows a mode or a model, never both.
    expect(session.getState().pendingMode).toBeNull()

    await session.send('Plain model.')
    await fake.waitForIdle()
    const sent = fake.history(fake.session.id).find((event) => event.type === 'user.message')
    expect(sent?.type === 'user.message' && sent.mode).toBeUndefined()
    expect(session.getState().modeId).toBeNull()

    session.setModel('openai/gpt-4.1-mini')
    session.setMode(mode.id)
    expect(session.getState().pendingModel).toBeNull()
    session.dispose()
  })

  it('reads the catalog for the in-chat picker', async () => {
    const fake = createFakeClient()
    const session = createChatSession({ client: fake, session: fake.session })

    const models = await session.listModels()

    expect(models.map((model) => model.id)).toContain('anthropic/claude-sonnet-5')
    session.dispose()
  })

  it('shows a session deleted elsewhere as a terminal notice (#114, U5)', async () => {
    const fake = createFakeClient()
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await fake.sessions.delete(fake.session.id)

    await waitFor(() => session.getState().transcript.deleted)
    expect(session.getState().phase).toBe('closed')
    expect(session.getState().notice?.text).toContain('deleted')
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

  it('keeps the clock the working indicator reads, and clears it between turns (#208)', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('A slow reply.', { chunks: 4, delayMs: 20 })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    expect(session.getState().runningSince).toBeNull()
    expect(session.getState().lastTextAt).toBeNull()

    await session.send('Go.')
    await waitFor(() => session.getState().runningSince !== null)
    await waitFor(() => session.getState().lastTextAt !== null)

    await fake.waitForIdle()
    await waitFor(() => session.getState().transcript.status === 'idle')

    // A turn that has ended has no clock: the elapsed time was about *that* turn, and the
    // next one starts its own.
    expect(session.getState().runningSince).toBeNull()
    expect(session.getState().lastTextAt).toBeNull()
    session.dispose()
  })

  it('names the reply whose metadata is still on its way (#208)', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('A reply.', { chunks: 3, delayMs: 5 })
    const { client, release } = holdingFirstSpanEnd(fake)
    const session = createChatSession({ client, session: fake.session })
    await session.start()

    await session.send('Go.')
    // The *stored* reply, not the preview the deltas stream into: the preview is not a
    // message anything will hold for, and the window this test is about opens the moment the
    // reply lands.
    await waitFor(() => {
      const messages = session.getState().transcript.messages
      return messages.some((message) => message.role === 'agent' && !message.streaming)
    })

    // The reply is complete on screen and its span end is still in flight, so the transcript
    // is still waiting on it. Holding that reply live is what lets its metadata line arrive
    // before Ink's `<Static>` writes the message for good.
    const reply = session
      .getState()
      .transcript.messages.find((message) => message.role === 'agent' && !message.streaming)
    expect(reply).toBeDefined()
    expect(session.getState().awaitingMetaId).toBe(reply?.id)

    release()
    await fake.waitForIdle()
    await waitFor(() => session.getState().awaitingMetaId === null)

    const settled = session.getState().transcript.messages.find((m) => m.role === 'agent')
    expect(settled?.meta?.usage?.total).toBeGreaterThan(0)
    session.dispose()
  })

  it('says a turn was interrupted, until there is a newer one (#208)', async () => {
    const fake = createFakeClient({ delayMs: 5 })
    fake.respondWith('One two three four', { chunks: 4, delayMs: 30 })
    const session = createChatSession({ client: fake, session: fake.session })
    await session.start()

    await session.send('Go.')
    await waitFor(() => session.getState().transcript.status === 'running')
    expect(session.getState().interrupted).toBe(false)

    expect(session.pressCtrlC()).toBe('interrupt')
    await waitFor(() => session.getState().interrupted)

    // It stays said after the turn ends: the reader is owed the answer to "what happened to
    // that?", which the partial reply on screen does not give.
    await fake.waitForIdle()
    await waitFor(() => session.getState().transcript.status === 'idle')
    expect(session.getState().interrupted).toBe(true)

    fake.respondWith('A second reply.', { chunks: 4, delayMs: 30 })
    await session.send('Again.')
    // Sending is enough to turn the line over, before the server has said anything: the next
    // turn is not the interrupted one, and `Interrupted` is about to be wrong either way.
    expect(session.getState().interrupted).toBe(false)
    session.dispose()
  })
})

/**
 * A client whose stream holds the first `span.model_request_end` back until the test lets it
 * through.
 *
 * The server writes a reply and *then* its span end — the reply is what the model produced,
 * the span end is the accounting for it — and the two can reach a client in different
 * batches, which is what puts a settled reply in the scrollback before its metadata. The fake
 * emits them back to back, so this is the seam that opens the gap wide enough for a test.
 */
function holdingFirstSpanEnd(fake: FakeClient): {
  readonly client: Client
  readonly release: () => void
} {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false

  const client: Client = {
    ...fake,
    sessions: {
      ...fake.sessions,
      events: {
        ...fake.sessions.events,
        async *stream(sessionId, options) {
          for await (const event of fake.sessions.events.stream(sessionId, options)) {
            if (!held && event.type === EVENT_TYPES.modelRequestEnd) {
              held = true
              await gate
            }
            yield event
          }
        },
      },
    },
  }

  return { client, release }
}
