import { afterEach, describe, expect, it } from 'vitest'
import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type SessionId,
} from '@openharness/protocol'

import {
  httpCreateAgent,
  httpCreateSession,
  postJson,
  readHistory,
  startTestServer,
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
  const transport = new DefaultChatTransport({
    api: `${test.url}${API_VERSION_PREFIX}/sessions/${sessionId}/ai-sdk/chat`,
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
