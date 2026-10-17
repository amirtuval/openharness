import { describe, expect, it } from 'vitest'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  EVENT_TYPES,
  MESSAGE_PARENT_TOOL_NAME,
  TASK_DESCRIPTION_MAX_LENGTH,
  TODO_WRITE_TOOL_NAME,
  readTodoList,
  type AgentMessageEvent,
  type ModelRequestEndEvent,
  type ModelRequestStartEvent,
  type SessionErrorEvent,
  type StoredEvent,
  type StreamEvent,
} from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'
import type { RetryPolicy } from '@openharness/brain'

import { createBundledRegistry } from './catalog/registry'
import { LocalScheduler } from './scheduler'
import { createTurnTools, TEST_TOOL_NAME } from './tools'
import {
  MESSAGE_PARENT_MARKER,
  MOCK_AGENT_MARKER,
  MOCK_AGENT_MESSAGE_MARKER,
  MOCK_AGENT_STOP_MARKER,
  MOCK_ECHO_CHUNKS,
  MOCK_HOLD_MARKER,
  MOCK_HOLD_TEXT,
  MOCK_MODEL_ENV_VALUE,
  MOCK_MODEL_USAGE,
  MOCK_RETRYABLE_MARKER,
  MOCK_SLOW_CHUNKS,
  MOCK_SLOW_MARKER,
  MOCK_SLOW_TOOL_MARKER,
  MOCK_SLOW_TOTAL_MS,
  MOCK_TERMINAL_MARKER,
  MOCK_TODO_DEFAULT_COUNT,
  MOCK_TODO_MARKER,
  MOCK_TODO_MAX_COUNT,
  MOCK_TOOL_MARKER,
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
  waitFor,
  waitForIdle,
} from './test-support'

/**
 * The deterministic test model: what it answers, how it fails, and the fact that it cannot
 * be reached without the environment variable.
 */

/** Run one whole turn of a session through the mock model. */
async function runTurn(
  text: string,
  options: { retry?: RetryPolicy; tools?: boolean; followUp?: string } = {},
): Promise<{ history: Awaited<ReturnType<typeof readHistory>>; previews: StreamEvent[] }> {
  const store = new InMemorySessionStore()
  const config = testConfig({})
  const scheduler = new LocalScheduler({
    store,
    model: createMockModelFactory(),
    resolveCredential: resolveTestSessionCredential,
    onError: () => {},
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    // The tools as `main.ts` wires them: the built-ins plus the test `echo` tool for the mock
    // model (epic #303; the built-ins are #305), and the support gate over the registry.
    ...(options.tools === true
      ? {
          tools: createTurnTools({
            config,
            kind: 'mock',
            store,
            registry: createBundledRegistry(),
          }),
        }
      : {}),
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
  if (options.followUp !== undefined) {
    // A second turn in the same chat: what a marker has to survive once the first one left
    // something in the log (a task list, most of all — the brain's reminder then rides after the
    // history of every later request, #331).
    await store.appendEvents(session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: options.followUp }] },
    ])
    scheduler.signal(session.id, 'work')
    await waitForIdle(store, session.id, 30_000)
  }
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

  it('calls the test tool for __tool__, and answers what it echoed (epic #303)', async () => {
    const { history } = await runTurn(`${MOCK_TOOL_MARKER} ping`, { tools: true })

    // The call is in the log before its answer, and the answer says what the tool produced.
    const useAt = history.findIndex((event) => event.type === EVENT_TYPES.agentToolUse)
    const resultAt = history.findIndex((event) => event.type === EVENT_TYPES.agentToolResult)
    expect(useAt).toBeGreaterThan(-1)
    expect(resultAt).toBe(useAt + 1)
    expect(history[useAt]).toMatchObject({
      name: TEST_TOOL_NAME,
      input: { text: 'ping' },
      evaluated_permission: 'allow',
    })
    expect(replies(history).join('\n')).toContain('the tool said: ping')
    // Two requests, not one: the answer to the call is what the model answered.
    expect(history.filter((event) => event.type === EVENT_TYPES.modelRequestStart)).toHaveLength(2)
  })

  it('offers the tool to the model, and calls nothing without one', async () => {
    const { history } = await runTurn(`${MOCK_TOOL_MARKER} ping`)

    const start = history.find(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    expect(start?.tools).toBeUndefined()
    expect(history.some((event) => event.type === EVENT_TYPES.agentToolUse)).toBe(false)
    // The mock makes the call anyway — nothing told it the request offered no tools — and the
    // loop, which has no registry to run a call with, stores nothing about it: a request that
    // offered no tools has no call in its log, and the turn ends idle behind it.
    expect(replies(history)).toEqual([])
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('writes a task list for __todos__, and answers with it (#305)', async () => {
    const { history } = await runTurn(`${MOCK_TODO_MARKER} 6`, { tools: true })

    // The call is `todo_write`, and the list a client draws is its own input — the newest
    // successful call is the state, which is what makes the terminal's pinned panel (#308) and
    // a reloaded chat agree about it.
    const call = history.find((event) => event.type === EVENT_TYPES.agentToolUse)
    expect(call).toMatchObject({
      name: TODO_WRITE_TOOL_NAME,
      evaluated_permission: 'allow',
    })
    const todos = readTodoList(history)
    expect(todos).toHaveLength(6)
    expect(todos?.[0]).toEqual({ content: 'step 1', status: 'done' })
    expect(todos?.[1]).toEqual({ content: 'step 2', status: 'in_progress' })
    expect(todos?.[5]).toEqual({ content: 'step 6', status: 'pending' })
    // The turn carries on: the second request is answered, and what it is answered to is the
    // list itself — the brain attaches the chat's task list to every request once it has one
    // (#331), and the mock echoes whatever it is shown.
    expect(history.filter((event) => event.type === EVENT_TYPES.modelRequestStart)).toHaveLength(2)
    expect(replies(history).join('\n')).toContain('[x] step 1')
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('still answers a marker once the chat has a task list (#331: the reminder rides last)', async () => {
    const { history } = await runTurn(`${MOCK_TODO_MARKER} 3`, {
      tools: true,
      followUp: `${MOCK_TODO_MARKER} 6`,
    })

    // The reminder the brain appends after the history is a user message, so a request in a chat
    // that has a list ends with it rather than with what the test wrote. The second marker still
    // reaches the model — the list is the six the second turn wrote.
    expect(readTodoList(history)).toHaveLength(6)
  })

  it('answers a bare __todos__ with the default list, and never an unbounded one', async () => {
    const { history } = await runTurn(MOCK_TODO_MARKER, { tools: true })
    expect(readTodoList(history)).toHaveLength(MOCK_TODO_DEFAULT_COUNT)

    const { history: silly } = await runTurn(`${MOCK_TODO_MARKER} 100000`, { tools: true })
    expect(readTodoList(silly)).toHaveLength(MOCK_TODO_MAX_COUNT)
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

describe('__slow_tool__', () => {
  it('streams the slow reply and then calls the echo tool (#378)', () => {
    const plan = planFor(`${MOCK_SLOW_TOOL_MARKER} hello`, 1)

    expect(plan.chunks).toHaveLength(MOCK_SLOW_CHUNKS)
    expect(plan.delayMs).toBeGreaterThan(0)
    expect(plan.chunks.join('')).toBe(slowReplyText())
    expect(plan.toolCalls).toEqual([{ name: TEST_TOOL_NAME, input: { text: 'hello' } }])
  })

  it('is matched before the `__slow__` marker it shares a prefix with', () => {
    // `__slow_tool__` is not `__slow__` plus something under `startsWith`, but the markers are
    // close enough that a reordered check would be a silent regression: assert the plan, not
    // the ordering, so what a test sees is a slow turn that calls a tool.
    expect(planFor(MOCK_SLOW_TOOL_MARKER, 1).toolCalls).toHaveLength(1)
    expect(planFor(MOCK_SLOW_MARKER, 1).toolCalls).toBeUndefined()
  })
})

describe('__hold__', () => {
  it('streams one chunk and then holds the turn open until an interrupt ends it', async () => {
    const store = new InMemorySessionStore()
    const scheduler = new LocalScheduler({
      store,
      model: createMockModelFactory(),
      resolveCredential: resolveTestSessionCredential,
      onError: () => {},
    })
    await scheduler.start()
    const agent = await store.createAgent(
      { name: 'Agent', model: { id: 'openharness-test/x' } },
      TEST_OWNER_ID,
    )
    const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })

    await store.appendEvents(session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: MOCK_HOLD_MARKER }] },
    ])
    scheduler.signal(session.id, 'work')

    // The request opens — its span start is in the log, so the session is `running` — and then
    // it stays open: nothing about a held reply ever closes the turn by itself.
    await waitFor(async () => (await store.getTurnState(session.id)).openSpan !== null, {
      message: 'the held request never opened',
    })

    // The test's own move ends it, exactly as a user's interrupt ends any reply in flight.
    await store.appendEvents(session.id, [{ type: EVENT_TYPES.userInterrupt }])
    scheduler.signal(session.id, 'interrupt')
    await waitForIdle(store, session.id, 30_000)
    await scheduler.stop()

    const history = await readHistory(store, session.id)
    const spanEnd = history.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.error?.type).toBe('interrupted')
    expect(replies(history)).toEqual([MOCK_HOLD_TEXT])
    expect(history.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
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
      EVENT_TYPES.sessionUsage,
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

describe('the subagent markers (epic #340, S5; #344)', () => {
  it('turns `__agent__ <type> | <prompt>` into an `agent` call', () => {
    expect(
      planFor(`${MOCK_AGENT_MARKER} researcher | Read the rewind code and report.`, 1).toolCalls,
    ).toEqual([
      {
        name: AGENT_TOOL_NAME,
        input: {
          type: 'researcher',
          description: 'Read the rewind code and report.',
          prompt: 'Read the rewind code and report.',
        },
      },
    ])
  })

  it('derives the description from the prompt’s first line, collapsed and bounded', () => {
    // A multi-line prompt is the common shape — a QA spec writes a paragraph — and the
    // description is a card's caption: the first line, one line, inside the protocol's cap.
    const plan = planFor(
      `${MOCK_AGENT_MARKER} general-purpose | First line.
Second line, which is not the description.`,
      1,
    )
    expect(plan.toolCalls?.[0]?.input).toEqual({
      type: 'general-purpose',
      description: 'First line.',
      prompt: `First line.
Second line, which is not the description.`,
    })

    const long = planFor(
      `${MOCK_AGENT_MARKER} general-purpose | ${'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH + 50)}`,
      1,
    )
    const description = (long.toolCalls?.[0]?.input as { description: string }).description
    expect(description.length).toBe(TASK_DESCRIPTION_MAX_LENGTH)
    expect(description.endsWith('…')).toBe(true)
  })

  it('turns `__agent_message__ <task_id> | <text>` into an `agent_message` call', () => {
    expect(planFor(`${MOCK_AGENT_MESSAGE_MARKER} task_1 | keep going`, 1).toolCalls).toEqual([
      { name: AGENT_MESSAGE_TOOL_NAME, input: { task_id: 'task_1', text: 'keep going' } },
    ])
    // A marker with no text still sends something: the tool's own schema refuses an empty one,
    // and a test that only wants to poke a task should not have to write a sentence.
    expect(planFor(`${MOCK_AGENT_MESSAGE_MARKER} task_1`, 1).toolCalls?.[0]?.input).toEqual({
      task_id: 'task_1',
      text: 'keep going',
    })
  })

  it('turns `__agent_stop__ <task_id>` into an `agent_stop` call', () => {
    expect(planFor(`${MOCK_AGENT_STOP_MARKER} task_1`, 1).toolCalls).toEqual([
      { name: AGENT_STOP_TOOL_NAME, input: { task_id: 'task_1' } },
    ])
  })

  it('turns `__message_parent__ <note>` into a `message_parent` call, note whole', () => {
    // The note is prose, and nothing in it is a field: the rest of the message is the text.
    expect(planFor(`${MESSAGE_PARENT_MARKER} half way | still going`, 1).toolCalls).toEqual([
      { name: MESSAGE_PARENT_TOOL_NAME, input: { text: 'half way | still going' } },
    ])
  })
})
