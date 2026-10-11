import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import {
  API_VERSION_PREFIX,
  ASK_USER_TOOL_NAME,
  EVENT_TYPES,
  ListToolSettingsResponseSchema,
  SessionSchema,
  type AgentToolResultEvent,
  type AgentToolUseEvent,
  type AskUserInput,
  type Session,
  type SessionId,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createBundledRegistry } from './catalog/registry'
import { askUserTool } from './pausing'
import {
  createTestApp,
  postJson,
  readHistory,
  waitFor,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * Pausing for the user over HTTP (epic #303, X6; issue #309): the `ask_user` tool this server
 * registers, and the checks a `user.tool_confirmation` passes before it is stored.
 *
 * The route is the half only a server can be asked about: a confirmation naming a call that is
 * not waiting is the protocol's 400 and stores nothing, the answers have to fit the questions
 * the call asked, and an approval the user asked to remember `always` becomes their stored
 * policy for that tool (#307). What a pause *means* is the brain's, and is driven there.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`
const TOOLS = `${API_VERSION_PREFIX}/me/tools`

/** The questions the scripted model asks. */
const QUESTIONS: AskUserInput = {
  questions: [
    {
      question: 'Which environment should I deploy to?',
      header: 'Environment',
      type: 'choice',
      options: [{ label: 'staging' }, { label: 'production' }],
    },
    { question: 'Anything else I should know?', header: 'Notes', type: 'text' },
  ],
}

/** The answers that fit {@link QUESTIONS}. */
const ANSWERS = [
  { question: 'Which environment should I deploy to?', labels: ['staging'] },
  { question: 'Anything else I should know?', text: 'the release is on Thursday' },
]

/** A `web_search`-shaped tool: the test's, since the built-ins are #305. */
const TEST_TOOL: ToolDefinition<{ query?: string }> = {
  name: 'web_search',
  description: 'Search.',
  inputSchema: z.object({ query: z.string().optional() }),
  permission: 'allow',
  run: (input) => textResult(`web_search: ${input.query ?? ''}`),
}

/** The registry the harness runs with: the real `ask_user` beside the test tool. */
const REGISTRY = createToolRegistry([askUserTool, TEST_TOOL])

/** A session created through the route. */
async function createSession(test: TestContext, model = 'openai/gpt-5-mini'): Promise<Session> {
  const response = await postJson(test, SESSIONS, { model: { id: model } })
  expect(response.status).toBe(201)
  return SessionSchema.parse(await response.json())
}

/** Post one event and answer the response, whatever its status. */
function post(test: TestContext, sessionId: SessionId, event: unknown): Promise<Response> {
  return postJson(test, `${SESSIONS}/${sessionId}/events`, { events: [event] })
}

/** Post one event and assert the append was accepted. */
async function send(test: TestContext, sessionId: SessionId, event: unknown): Promise<void> {
  const response = await post(test, sessionId, event)
  expect(response.status).toBe(200)
}

/** A `user.message`. */
function message(text: string): unknown {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** Every stored event of a session. */
async function log(test: TestContext, sessionId: SessionId) {
  return await readHistory(test.store, sessionId)
}

/** The calls a session's log holds, in order. */
function callsOf(events: readonly { readonly type: string }[]): AgentToolUseEvent[] {
  return events.filter(
    (event): event is AgentToolUseEvent => event.type === EVENT_TYPES.agentToolUse,
  )
}

/** The results a session's log holds, in order. */
function resultsOf(events: readonly { readonly type: string }[]): AgentToolResultEvent[] {
  return events.filter(
    (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
  )
}

/** A result's text, as one line. */
function textOf(result: AgentToolResultEvent | undefined): string {
  return result === undefined ? '' : result.content.map((block) => block.text).join('')
}

/** Wait until the session's log holds a call, and answer it. */
async function firstCall(test: TestContext, sessionId: SessionId): Promise<AgentToolUseEvent> {
  let call: AgentToolUseEvent | undefined
  await waitFor(
    async () => {
      call = callsOf(await log(test, sessionId))[0]
      return call !== undefined
    },
    { message: `session ${sessionId} never stored a tool call` },
  )
  // The turn that made it has to be over before the confirmation is posted: a confirmation is
  // only accepted while its call is waiting, and a call is waiting once the turn ends on it.
  await waitForIdle(test.store, sessionId)
  return call as AgentToolUseEvent
}

/** The error type and message of a refusal body, typed rather than `any`. */
async function errorOf(
  response: Response,
): Promise<{ readonly type: string; readonly message: string }> {
  const body = (await response.json()) as { error: { type: string; message: string } }
  return body.error
}

/** The tool entries the caller's settings answer. */
async function listTools(test: TestContext): Promise<{ name: string; policy: string }[]> {
  const response = await test.request(TOOLS)
  expect(response.status).toBe(200)
  return ListToolSettingsResponseSchema.parse(await response.json()).data
}

describe('a user.tool_confirmation over the wire', () => {
  it('answers an ask_user call with the answers, and the turn carries on', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [
        { toolCalls: [{ name: ASK_USER_TOOL_NAME, input: QUESTIONS }] },
        { text: ['deploying to staging'] },
      ],
    })
    const session = await createSession(test)
    await send(test, session.id, message('deploy it'))

    const call = await firstCall(test, session.id)
    expect(call).toMatchObject({ name: ASK_USER_TOOL_NAME, evaluated_permission: 'ask' })
    expect(resultsOf(await log(test, session.id))).toEqual([])

    await send(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: call.id,
      result: 'allow',
      answers: ANSWERS,
    })
    await waitForIdle(test.store, session.id)

    // The answers are the call's result — `ask_user` never runs — and the model was asked again.
    const events = await log(test, session.id)
    const result = resultsOf(events).at(-1)
    expect(result).toMatchObject({ tool_use_id: call.id, is_error: false })
    expect(textOf(result)).toBe(
      [
        'Which environment should I deploy to?: staging',
        'Anything else I should know?: the release is on Thursday',
      ].join('\n'),
    )
    const idle = events.filter((event) => event.type === EVENT_TYPES.sessionStatusIdle).at(-1)
    expect(idle).toMatchObject({ stop_reason: { type: 'end_turn' } })
    expect(
      events
        .filter((event) => event.type === EVENT_TYPES.agentMessage)
        .map((event) => event.content.map((block) => block.text).join(''))
        .join(''),
    ).toContain('deploying to staging')
  })

  it('refuses a confirmation for a call that is not waiting, and stores nothing', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [
        { toolCalls: [{ name: 'web_search', input: { query: 'tools' } }] },
        { text: ['found it'] },
      ],
    })
    const session = await createSession(test)
    await send(test, session.id, message('search for me'))
    await waitForIdle(test.store, session.id)

    // `web_search` is allowed outright, so its call ran: nothing about it is waiting.
    const allowed = callsOf(await log(test, session.id))[0]
    const before = await log(test, session.id)
    const response = await post(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: allowed?.id,
      result: 'allow',
    })

    expect(response.status).toBe(400)
    expect((await errorOf(response)).type).toBe('invalid_request_error')
    // Nothing was appended: a confirmation nobody can act on is not a fact the log carries.
    expect(await log(test, session.id)).toEqual(before)

    // An id no call of this session has is the same refusal.
    const unknown = await post(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: 'sevt_00000000000000000000000000',
      result: 'allow',
    })
    expect(unknown.status).toBe(400)
  })

  it('refuses answers that do not fit the questions the call asked', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [{ toolCalls: [{ name: ASK_USER_TOOL_NAME, input: QUESTIONS }] }, { text: ['ok'] }],
    })
    const session = await createSession(test)
    await send(test, session.id, message('deploy it'))
    const call = await firstCall(test, session.id)

    const wrong = await post(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: call.id,
      result: 'allow',
      answers: [
        { question: 'Which environment should I deploy to?', labels: ['somewhere else'] },
        { question: 'Anything else I should know?', text: 'no' },
      ],
    })
    expect(wrong.status).toBe(400)
    expect((await errorOf(wrong)).message).toContain('is not an option')

    const incomplete = await post(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: call.id,
      result: 'allow',
      answers: [{ question: 'Anything else I should know?', text: 'no' }],
    })
    expect(incomplete.status).toBe(400)
    expect((await errorOf(incomplete)).message).toContain('no answer was given')

    // An approval of a question without answers, `remember` on one, and `answers` on a call
    // that asked nothing are each refused before anything is stored.
    expect(
      (
        await post(test, session.id, {
          type: EVENT_TYPES.userToolConfirmation,
          tool_use_id: call.id,
          result: 'allow',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await post(test, session.id, {
          type: EVENT_TYPES.userToolConfirmation,
          tool_use_id: call.id,
          result: 'allow',
          remember: 'session',
          answers: ANSWERS,
        })
      ).status,
    ).toBe(400)
    expect(resultsOf(await log(test, session.id))).toEqual([])
  })

  it('refuses `answers` for a call that asked no questions', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [
        { toolCalls: [{ name: 'web_search', input: { query: 'tools' } }] },
        { text: ['found it'] },
      ],
    })
    const session = await createSession(test)
    await send(test, session.id, message('search for me'))
    const call = await firstCall(test, session.id)

    // The policy is `allow`, so the call is not waiting at all — but the refusal is about the
    // `answers` field even for a call that was: the check runs on the call it names.
    const response = await post(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: call.id,
      result: 'allow',
      answers: ANSWERS,
    })
    expect(response.status).toBe(400)
  })
})

describe('an approval remembered for always', () => {
  it('writes the user’s policy for that tool, and the next chat runs without asking', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [
        { toolCalls: [{ name: 'web_search', input: { query: 'tools' } }] },
        { text: ['found it'] },
      ],
    })
    const session = await createSession(test)
    const put = await test.request(TOOLS, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ builtin: { web_search: { enabled: true, policy: 'ask' } } }),
    })
    expect(put.status).toBe(200)

    await send(test, session.id, message('search for me'))
    const call = await firstCall(test, session.id)
    expect(call).toMatchObject({ name: 'web_search', evaluated_permission: 'ask' })

    await send(test, session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: call.id,
      result: 'allow',
      remember: 'always',
    })
    await waitForIdle(test.store, session.id)

    // The policy is the user's stored choice now — the next chat inherits it — and this chat
    // read the answer back off the log, so the call ran.
    const entries = await listTools(test)
    expect(entries.find((entry) => entry.name === 'web_search')?.policy).toBe('allow')
    const result = resultsOf(await log(test, session.id)).at(-1)
    expect(textOf(result)).toBe('web_search: tools')
  })
})
