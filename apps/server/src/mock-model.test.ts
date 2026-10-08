import { describe, expect, it } from 'vitest'
import {
  EVENT_TYPES,
  type AgentMessageEvent,
  type ModelRequestEndEvent,
  type SessionErrorEvent,
  type StoredEvent,
  type StreamEvent,
} from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'
import type { RetryPolicy } from '@openharness/brain'

import { LocalScheduler } from './scheduler'
import {
  MOCK_ECHO_CHUNKS,
  MOCK_MODEL_ENV_VALUE,
  MOCK_MODEL_USAGE,
  MOCK_RETRYABLE_MARKER,
  MOCK_SLOW_CHUNKS,
  MOCK_SLOW_MARKER,
  MOCK_SLOW_TOTAL_MS,
  MOCK_TERMINAL_MARKER,
  chunkText,
  createMockModelFactory,
  planFor,
  slowReplyText,
} from './mock-model'
import { resolveModelFactory } from './model'
import {
  TEST_OWNER_ID,
  readHistory,
  resolveTestSessionCredential,
  testConfig,
  waitForIdle,
} from './test-support'

/**
 * The deterministic test model: what it answers, how it fails, and the fact that it cannot
 * be reached without the environment variable.
 */

/** Run one whole turn of a session through the mock model. */
async function runTurn(
  text: string,
  options: { retry?: RetryPolicy } = {},
): Promise<{ history: Awaited<ReturnType<typeof readHistory>>; previews: StreamEvent[] }> {
  const store = new InMemorySessionStore()
  const scheduler = new LocalScheduler({
    store,
    model: createMockModelFactory(),
    resolveCredential: resolveTestSessionCredential,
    onError: () => {},
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  })
  await scheduler.start()
  const agent = await store.createAgent(
    { name: 'Agent', model: { id: 'openharness-test/x' } },
    TEST_OWNER_ID,
  )
  const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
  const previews: StreamEvent[] = []
  await store.subscribe(session.id, (event) => {
    previews.push(event)
  })

  await store.appendEvents(session.id, [
    { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] },
  ])
  scheduler.signal(session.id, 'work')
  await waitForIdle(store, session.id, 30_000)
  const history = await readHistory(store, session.id)
  await scheduler.stop()
  return { history, previews }
}

/** The text of the agent's replies in a log. */
function replies(history: readonly StoredEvent[]): string[] {
  return history.flatMap((event) =>
    event.type === EVENT_TYPES.agentMessage ? [textOf(event)] : [],
  )
}

/** The text one agent message carries. */
function textOf(event: AgentMessageEvent): string {
  return event.content.map((block) => block.text).join('')
}

describe('the echo', () => {
  it('answers with the message, streamed in several chunks', async () => {
    const message = 'Hello from the test model'
    const { history, previews } = await runTurn(message)

    expect(replies(history)).toEqual([message])
    const deltas = previews.filter((event) => event.type === EVENT_TYPES.eventDelta)
    expect(deltas).toHaveLength(MOCK_ECHO_CHUNKS)
    // The chunked previews are the reply, split: a client accumulating them holds the text.
    expect(
      deltas
        .flatMap((event) =>
          event.type === EVENT_TYPES.eventDelta ? [event.delta.content.text] : [],
        )
        .join(''),
    ).toBe(message)
  })

  it('reports fixed usage, so a test can assert the exact numbers', async () => {
    const { history } = await runTurn('usage please')

    const spanEnd = history.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.model_usage).toEqual(MOCK_MODEL_USAGE)
    expect(spanEnd?.is_error).toBeNull()
  })
})

describe('__slow__', () => {
  it('is a plan of many chunks over about ten seconds', () => {
    const plan = planFor(MOCK_SLOW_MARKER, 1)

    expect(plan.chunks).toHaveLength(MOCK_SLOW_CHUNKS)
    expect(plan.error).toBeUndefined()
    expect(MOCK_SLOW_TOTAL_MS).toBeGreaterThanOrEqual(8000)
    expect(plan.chunks.join('')).toBe(slowReplyText())
  })

  it('is the same text on every run', () => {
    expect(slowReplyText()).toBe(slowReplyText())
  })
})

describe('__fail_retryable__', () => {
  it('fails the first attempt with a 503 and succeeds on the retry', async () => {
    const { history } = await runTurn(MOCK_RETRYABLE_MARKER, { retry: { baseDelayMs: 1 } })

    expect(history.map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const error = history.find(
      (event): event is SessionErrorEvent => event.type === EVENT_TYPES.sessionError,
    )
    expect(error?.error.retry_status.type).toBe('retrying')
    expect(error?.error.type).toBe('model_overloaded_error')
    expect(replies(history)).toEqual([MOCK_RETRYABLE_MARKER])
  })
})

describe('__fail_terminal__', () => {
  it('fails every attempt with a 400 and ends the turn', async () => {
    const { history } = await runTurn(MOCK_TERMINAL_MARKER, { retry: { baseDelayMs: 1 } })

    const errors = history.filter(
      (event): event is SessionErrorEvent => event.type === EVENT_TYPES.sessionError,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error.retry_status.type).toBe('terminal')
    expect(errors[0]?.error.type).toBe('model_request_failed_error')
    expect(replies(history)).toEqual([])
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })
})

describe('the hook', () => {
  it('never activates the mock unless the environment asks for it', () => {
    expect(resolveModelFactory(testConfig()).kind).toBe('provider')
    expect(resolveModelFactory({ ...testConfig(), testModel: MOCK_MODEL_ENV_VALUE }).kind).toBe(
      'mock',
    )
  })

  it('refuses an environment value that is neither unset nor mock', () => {
    expect(() => resolveModelFactory({ ...testConfig(), testModel: 'yes' })).toThrow(
      /OPENHARNESS_TEST_MODEL/,
    )
  })
})

describe('chunkText', () => {
  it('splits into at most the requested number of pieces', () => {
    expect(chunkText('abcdefgh', 4)).toEqual(['ab', 'cd', 'ef', 'gh'])
    expect(chunkText('abcd', 4)).toEqual(['a', 'b', 'c', 'd'])
    expect(chunkText('', 4)).toEqual([])
  })

  it('never splits a character outside the BMP in half', () => {
    const chunks = chunkText('🙂🙂', 2)

    expect(chunks.join('')).toBe('🙂🙂')
    expect(chunks.every((chunk) => Array.from(chunk).length === 1)).toBe(true)
  })
})
