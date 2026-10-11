import {
  MOCK_ASK_ANSWERS,
  MOCK_ASK_MARKER,
  MOCK_TOOL_MARKER,
  TEST_TOOL_NAME,
} from '@openharness/server'
import { ASK_USER_TOOL_NAME, EVENT_TYPES, newEventId } from '@openharness/protocol'
import type {
  AgentToolResultEvent,
  AgentToolUseEvent,
  EventId,
  SessionStatusIdleEvent,
  StoredEvent,
  ToolSettingEntry,
  UserMessageEvent,
  UserToolConfirmationEvent,
} from '@openharness/protocol'
import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import type { Person, ServerProcess } from './harness'
import { e2eHarness, errorOf, personFor, readLog, waitFor, waitForTurnEnd } from './harness'

/**
 * Pausing for the user, end to end (epic #303, X6; issue #309).
 *
 * The whole path through the real server, a real Postgres and the built client: the model calls
 * `ask_user` — or a tool the user's settings said to ask about — the brain stores the call and
 * ends the turn idle with `requires_action`, nothing runs, and one `user.tool_confirmation`
 * starts the turn that answers it: with the user's answers as the call's result, or with the
 * tool run because they allowed it. The log is the evidence throughout, as it is for the loop.
 */

const harness = e2eHarness('pausing')

/** A person of this file's own, so one test's settings cannot reach the next. */
async function person(server: ServerProcess, label: string): Promise<Person> {
  return personFor(
    server,
    await harness.user(server, {
      email: `${label}@pausing.example.com`,
      password: 'e2e-password-123',
    }),
  )
}

/** One `/v1/me/tools` call, as the caller's bearer token. */
async function tools(
  server: ServerProcess,
  who: Person,
  init: RequestInit & { readonly body?: string } = {},
): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/me/tools`, {
    ...init,
    headers: {
      authorization: `Bearer ${who.signedIn.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

/** The stored events of one type, in order, narrowed to that kind. */
function of<T extends StoredEvent['type']>(
  log: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return log.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** The text a result carries, as one line. */
function textOf(result: AgentToolResultEvent | undefined): string {
  return result === undefined ? '' : result.content.map((block) => block.text).join('')
}

/** The last `session.status_idle` of a log. */
function idleOf(log: readonly StoredEvent[]): SessionStatusIdleEvent | undefined {
  return of(log, EVENT_TYPES.sessionStatusIdle).at(-1)
}

/** Send one message and answer the stored event, which says which turn the wait means. */
async function say(client: Client, sessionId: string, text: string): Promise<UserMessageEvent> {
  return await client.sendMessage(sessionId, text)
}

/**
 * The call the session paused on, waited for: the log holds it, and the turn that made it ended.
 *
 * "Ended" matters: a call is only waiting once the turn that made it has written its idle, and
 * a confirmation posted before that would be refused for naming a call that is not waiting yet.
 */
async function pausedCall(
  client: Client,
  sessionId: string,
  name: string,
): Promise<AgentToolUseEvent> {
  const call = await waitFor(
    `session ${sessionId} to pause on a call to ${name}`,
    async () =>
      of(await readLog(client, sessionId), EVENT_TYPES.agentToolUse).find(
        (event) => event.name === name,
      ),
    { describe: () => 'a log holding no such call' },
  )
  await waitForTurnEnd(client, sessionId)
  return call
}

/** Answer a call, and answer the stored confirmation — the position the next turn begins at. */
async function confirm(
  client: Client,
  sessionId: string,
  body: {
    readonly tool_use_id: EventId
    readonly result: 'allow' | 'deny'
    readonly deny_message?: string
    readonly remember?: 'once' | 'session' | 'always'
    readonly answers?: readonly {
      readonly question: string
      readonly labels?: readonly string[]
      readonly text?: string
      readonly confirmed?: boolean
    }[]
  },
): Promise<UserToolConfirmationEvent> {
  await client.sessions.events.send(sessionId, {
    type: EVENT_TYPES.userToolConfirmation,
    ...body,
  })
  const stored = of(await readLog(client, sessionId), EVENT_TYPES.userToolConfirmation).at(-1)
  if (stored === undefined) {
    throw new Error('the confirmation was accepted but the log does not hold it')
  }
  return stored
}

/** Every `agent.message` of a log, as text. */
function repliesOf(log: readonly StoredEvent[]): string[] {
  return of(log, EVENT_TYPES.agentMessage).map((event) =>
    event.content.map((block) => block.text).join(''),
  )
}

describe('a pause through the real server', () => {
  it('asks the user, waits, and carries on with their answers', async () => {
    const server = await harness.server()
    const me = await person(server, 'asks')
    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await say(me.client, session.id, `${MOCK_ASK_MARKER} deploy it`)
    const call = await pausedCall(me.client, session.id, ASK_USER_TOOL_NAME)

    // The turn ended idle naming the question, nothing ran, and no result was written: the
    // session is waiting, and the pause is a fact of the log rather than of the process.
    let log = await readLog(me.client, session.id)
    expect(call).toMatchObject({ evaluated_permission: 'ask' })
    expect(call.input).toMatchObject({ questions: [{ type: 'choice' }, { type: 'text' }] })
    expect(of(log, EVENT_TYPES.agentToolResult)).toEqual([])
    expect(idleOf(log)?.stop_reason).toEqual({ type: 'requires_action', event_ids: [call.id] })

    // The user answers: one event, carrying the answers the questions asked for, and the brain
    // writes them as the call's result — `ask_user` never runs.
    const confirmation = await confirm(me.client, session.id, {
      tool_use_id: call.id,
      result: 'allow',
      answers: MOCK_ASK_ANSWERS,
    })
    await waitForTurnEnd(me.client, session.id, { afterSeq: confirmation.seq })

    log = await readLog(me.client, session.id)
    const result = of(log, EVENT_TYPES.agentToolResult).at(-1)
    expect(result).toMatchObject({ tool_use_id: call.id, is_error: false })
    expect(textOf(result)).toBe(
      [
        'Which environment should I deploy to?: staging',
        'Anything else I should know?: the release is on Thursday',
      ].join('\n'),
    )
    // The turn carried on: the model was asked again and answered what it was told.
    expect(repliesOf(log).join('\n')).toContain(
      'the tool said: Which environment should I deploy to?: staging',
    )
    expect(idleOf(log)?.stop_reason).toEqual({ type: 'end_turn' })
  })

  it('runs an approved call, remembers the approval for the session, and refuses a stale one', async () => {
    const server = await harness.server()
    const me = await person(server, 'approves')
    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    // The user asks to be consulted about the test tool (#307), so a call to it pauses.
    const written = await tools(server, me, {
      method: 'PUT',
      body: JSON.stringify({ builtin: { [TEST_TOOL_NAME]: { enabled: true, policy: 'ask' } } }),
    })
    expect(written.status).toBe(200)

    const first = await say(me.client, session.id, `${MOCK_TOOL_MARKER} through the real server`)
    const call = await pausedCall(me.client, session.id, TEST_TOOL_NAME)
    expect(call).toMatchObject({ evaluated_permission: 'ask' })
    expect(of(await readLog(me.client, session.id), EVENT_TYPES.agentToolResult)).toEqual([])
    expect(idleOf(await readLog(me.client, session.id))?.stop_reason).toEqual({
      type: 'requires_action',
      event_ids: [call.id],
    })
    expect(first.seq).toBeLessThan(call.seq)

    // The user allows it, and asks the chat to remember.
    const confirmation = await confirm(me.client, session.id, {
      tool_use_id: call.id,
      result: 'allow',
      remember: 'session',
    })
    await waitForTurnEnd(me.client, session.id, { afterSeq: confirmation.seq })

    // The approved call ran — the result is the tool's own output — and the turn carried on.
    let log = await readLog(me.client, session.id)
    expect(textOf(of(log, EVENT_TYPES.agentToolResult).at(-1))).toBe('through the real server')
    expect(idleOf(log)?.stop_reason).toEqual({ type: 'end_turn' })

    // A second confirmation for the same call names a call that is not waiting any more, and is
    // the protocol's 400 that stores nothing.
    const refused = await errorOf(() =>
      me.client.sessions.events.send(session.id, {
        type: EVENT_TYPES.userToolConfirmation,
        tool_use_id: call.id,
        result: 'allow',
      }),
    )
    expect(refused.status).toBe(400)
    expect(refused.type).toBe('invalid_request_error')

    // The approval is remembered for this chat: the next call to the same tool runs without
    // asking again, and is recorded as a call that ran under `allow`.
    const second = await say(me.client, session.id, `${MOCK_TOOL_MARKER} a second time`)
    await waitForTurnEnd(me.client, session.id, { afterSeq: second.seq })
    log = await readLog(me.client, session.id)
    const calls = of(log, EVENT_TYPES.agentToolUse)
    expect(calls).toHaveLength(2)
    expect(calls.at(-1)).toMatchObject({ evaluated_permission: 'allow', name: TEST_TOOL_NAME })
    expect(textOf(of(log, EVENT_TYPES.agentToolResult).at(-1))).toBe('a second time')

    // And the chat's record is the confirmation, not a setting: the policy is still the user's
    // own choice, ready to ask again in the next chat.
    const listed = ((await (await tools(server, me)).json()) as { data: ToolSettingEntry[] }).data
    expect(listed.find((entry) => entry.name === TEST_TOOL_NAME)?.policy).toBe('ask')
  })

  it('resolves a waiting call when the user sends a message instead', async () => {
    const server = await harness.server()
    const me = await person(server, 'instead')
    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await say(me.client, session.id, `${MOCK_ASK_MARKER} deploy it`)
    const call = await pausedCall(me.client, session.id, ASK_USER_TOOL_NAME)

    const instead = await say(me.client, session.id, 'never mind')
    await waitForTurnEnd(me.client, session.id, { afterSeq: instead.seq })

    const log = await readLog(me.client, session.id)
    const result = of(log, EVENT_TYPES.agentToolResult).at(-1)
    expect(result).toMatchObject({ tool_use_id: call.id, is_error: true })
    expect(textOf(result)).toBe('The user sent a message instead.')
    // No confirmation was ever sent, the call never ran, and the message was answered.
    expect(of(log, EVENT_TYPES.userToolConfirmation)).toEqual([])
    expect(idleOf(log)?.stop_reason).toEqual({ type: 'end_turn' })
    expect(repliesOf(log).join('\n')).toContain('never mind')
  })

  it('refuses a confirmation for a call no session is waiting on, and stores nothing', async () => {
    const server = await harness.server()
    const me = await person(server, 'refusals')
    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    const hello = await say(me.client, session.id, 'hello there')
    await waitForTurnEnd(me.client, session.id, { afterSeq: hello.seq })
    const before = await readLog(me.client, session.id)

    const refused = await errorOf(() =>
      me.client.sessions.events.send(session.id, {
        type: EVENT_TYPES.userToolConfirmation,
        // A well-formed id that names no call: the refusal is about the call, not the shape.
        tool_use_id: newEventId(),
        result: 'allow',
      }),
    )

    expect(refused.status).toBe(400)
    expect(refused.type).toBe('invalid_request_error')
    expect(await readLog(me.client, session.id)).toEqual(before)
  })
})
