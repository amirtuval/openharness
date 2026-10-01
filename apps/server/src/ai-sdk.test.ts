import { afterEach, describe, expect, it } from 'vitest'
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type SessionId,
} from '@openharness/protocol'

import {
  ObservableStore,
  httpCreateAgent,
  httpCreateSession,
  postJson,
  readHistory,
  startTestServer,
  waitFor,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * `POST /v1/sessions/{id}/ai-sdk/chat`, driven by the AI SDK's own client side.
 *
 * `DefaultChatTransport` is what `useChat` uses to POST, and `readUIMessageStream` is what it
 * does with the answer — so this is the client's shape on both ends rather than a hand-rolled
 * request that might agree with the server by accident.
 */

let context: TestContext | undefined

afterEach(async () => {
  await context?.close()
  context = undefined
})

/** A UI message the way `useChat` holds one. */
function userMessage(text: string): UIMessage {
  return { id: 'message-1', role: 'user', parts: [{ type: 'text', text }] }
}

/** POST the way `useChat` does, and read the stream the way `useChat` does. */
async function chat(
  test: TestContext,
  sessionId: SessionId,
  messages: UIMessage[],
): Promise<{ text: string; chunks: UIMessageChunk[] }> {
  // The route is behind the /v1 guard, so the transport carries the caller's bearer token —
  // exactly what a `useChat` app configured with the CLI's token would do.
  const { token } = await test.signIn()
  const transport = new DefaultChatTransport({
    api: `${test.url}${API_VERSION_PREFIX}/sessions/${sessionId}/ai-sdk/chat`,
    headers: { authorization: `Bearer ${token}` },
  })
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: sessionId,
    messageId: undefined,
    messages,
    abortSignal: undefined,
  })

  const [forChunks, forMessages] = stream.tee()
  const chunks: UIMessageChunk[] = []
  const reading = (async () => {
    for await (const chunk of forChunks) {
      chunks.push(chunk)
    }
  })()

  let message: UIMessage | undefined
  for await (const snapshot of readUIMessageStream({ stream: forMessages })) {
    message = snapshot
  }
  await reading

  const text = (message?.parts ?? [])
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
  return { text, chunks }
}

describe('the subscription', () => {
  it('is released when the turn ends', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store, replies: [{ text: ['bye'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    await chat(test, session.id, [userMessage('Hi')])

    await waitFor(() => store.subscriptions > 0)
    await waitFor(() => store.unsubscribed > 0, {
      message: 'the store subscription outlived the chat request',
    })
  })
})

describe('the AI SDK chat endpoint', () => {
  it('streams a full reply, and stores it as a turn', async () => {
    const test = await startTestServer({ replies: [{ text: ['Hello ', 'from ', 'the server'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const { text, chunks } = await chat(test, session.id, [userMessage('Hi there')])

    expect(text).toBe('Hello from the server')
    expect(chunks[0]?.type).toBe('start')
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)

    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    expect(history[0]).toMatchObject({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'Hi there' }],
    })
    const reply = history.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(reply).toMatchObject({ type: EVENT_TYPES.agentMessage })
  })

  it('streams the stored chunks of a reply as they arrive (D9)', async () => {
    // Since D9 the brain stores every chunk it streams. This adapter reads the session's live
    // events, so what it translates is the stored `event_start` / `event_delta` — under the
    // `sevt_` id the stored `agent.message` will have, exactly as the stream-only previews
    // used to be.
    const test = await startTestServer({ replies: [{ text: ['One ', 'two'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const { text, chunks } = await chat(test, session.id, [userMessage('Hi')])
    await waitForIdle(test.store, session.id)

    expect(text).toBe('One two')
    const start = chunks.find((chunk) => chunk.type === 'text-start')
    const deltas = chunks.filter((chunk) => chunk.type === 'text-delta')
    expect(start?.type === 'text-start' && start.id).toMatch(/^sevt_/)
    expect(deltas.map((delta) => (delta.type === 'text-delta' ? delta.delta : '')).join('')).toBe(
      'One two',
    )
    expect(chunks.some((chunk) => chunk.type === 'text-end')).toBe(true)

    // The id the block streamed under is the id the stored message has: a client that saw the
    // live text can replace it with the record it reads back from the log.
    const raw = await readHistory(test.store, session.id, { includeSuperseded: true })
    const chunkStart = raw.find((event) => event.type === EVENT_TYPES.eventStart)
    expect(chunkStart?.type === 'event_start' && chunkStart.event.id).toBe(
      start?.type === 'text-start' ? start.id : '',
    )
    const stored = raw.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(stored?.id).toBe(start?.type === 'text-start' ? start.id : '')
  })

  it('carries a session.error to the client as an error chunk', async () => {
    const test = await startTestServer({
      replies: [{ failWith: Object.assign(new Error('the model said no'), { statusCode: 400 }) }],
    })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const { chunks } = await chat(test, session.id, [userMessage('Hi')])

    const error = chunks.find((chunk) => chunk.type === 'error')
    expect(error?.type === 'error' && error.errorText).toContain('the model said no')
  })

  it('answers 400 when the request carries no user text', async () => {
    const test = await startTestServer()
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await postJson(
      test,
      `${API_VERSION_PREFIX}/sessions/${session.id}/ai-sdk/chat`,
      { id: session.id, messages: [], trigger: 'submit-message' },
    )

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })

  it('answers 404 for a session that does not exist', async () => {
    const test = await startTestServer()
    context = test

    const response = await postJson(
      test,
      `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ/ai-sdk/chat`,
      { messages: [userMessage('Hi')] },
    )

    expect(response.status).toBe(404)
  })

  it('reads a message sent in the older content-string shape', async () => {
    const test = await startTestServer({ replies: [{ text: ['ok'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await postJson(
      test,
      `${API_VERSION_PREFIX}/sessions/${session.id}/ai-sdk/chat`,
      { id: session.id, messages: [{ id: 'm1', role: 'user', content: 'plain text' }] },
    )

    expect(response.status).toBe(200)
    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    expect(history[0]).toMatchObject({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'plain text' }],
    })
  })
})
