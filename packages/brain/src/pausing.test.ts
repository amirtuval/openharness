import { createToolRegistry, errorResult, textResult } from '@openharness/hands'
import type { ToolDefinition, ToolResult } from '@openharness/hands'
import type {
  AskUserInput,
  EventId,
  SessionId,
  StoredEvent,
  StoredEventType,
} from '@openharness/protocol'
import { ASK_USER_TOOL_NAME, AskUserInputSchema, EVENT_TYPES } from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import {
  makeAgentToolUse,
  makeToolConfirmation,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { statusRunning } from './events'
import {
  RESOLVED_BY_MESSAGE,
  answeredWaiting,
  awaitingUser,
  confirmationsByCall,
  sessionApprovedTools,
  waitsForUser,
} from './pausing'
import type { ToolSettings } from './tools'
import { lostExecutions } from './tools'
import { eventTypes, logOf, message, newSession, textOf } from './testing/harness'
import { mockModel, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * Pausing for the user, driven through the loop (epic #303, X6; issue #309).
 *
 * Every path is a turn of its own against a real store: the call is stored instead of run, the
 * session goes idle naming it, and one `user.tool_confirmation` is what starts the turn that
 * carries on. Nothing is mocked but the model and the store, and the log is the evidence
 * throughout — a pause is a fact about the log, so that is where these tests look.
 */

/** The questions the scripted `ask_user` call asks. */
const QUESTIONS: AskUserInput = {
  questions: [
    {
      question: 'Which environment should I deploy to?',
      header: 'Environment',
      type: 'choice',
      options: [{ label: 'staging' }, { label: 'production', description: 'the live one' }],
    },
    { question: 'Anything else I should know?', header: 'Notes', type: 'text' },
    { question: 'Shall I ship it?', header: 'Ship', type: 'confirm' },
  ],
}

/** The answers a test sends back for {@link QUESTIONS}. */
const ANSWERS = [
  { question: 'Which environment should I deploy to?', labels: ['staging'] },
  { question: 'Anything else I should know?', text: 'the release is on Thursday' },
  { question: 'Shall I ship it?', confirmed: true },
]

/** An `echo` tool, and the spy that says whether it ran. */
function echo(): {
  readonly tool: ToolDefinition<{ text: string }>
  readonly run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn<(input: { text: string }) => ToolResult | Promise<ToolResult>>((input) =>
    textResult(input.text),
  )
  return {
    tool: {
      name: 'echo',
      description: 'Echo the text back.',
      inputSchema: z.object({ text: z.string() }),
      permission: 'allow',
      run,
    },
    run,
  }
}

/**
 * The `ask_user` tool as the server registers it: the protocol's schema, a declared policy of
 * `allow`, and a `run` that is never reached — a call to it is answered by the user.
 */
function askUser(): {
  readonly tool: ToolDefinition<AskUserInput>
  readonly run: ReturnType<typeof vi.fn>
} {
  const run = vi.fn<() => ToolResult>(() => errorResult('ask_user is answered by the user.'))
  return {
    tool: {
      name: ASK_USER_TOOL_NAME,
      description: 'Ask the user a question.',
      inputSchema: AskUserInputSchema,
      permission: 'allow',
      run,
    },
    run,
  }
}

/** The stored events of one type, in order, narrowed to that kind. */
function of<T extends StoredEventType>(
  log: readonly StoredEvent[],
  type: T,
): Extract<StoredEvent, { type: T }>[] {
  return log.filter((event): event is Extract<StoredEvent, { type: T }> => event.type === type)
}

/** The text of a tool result, which carries content blocks the way a message does. */
function resultText(
  event: { readonly content: readonly { readonly text: string }[] } | undefined,
): string {
  return event === undefined ? '' : event.content.map((block) => block.text).join('')
}

/** The status idle that closed a turn. */
function idleOf(
  log: readonly StoredEvent[],
): Extract<StoredEvent, { type: 'session.status_idle' }> {
  const idle = of(log, EVENT_TYPES.sessionStatusIdle).at(-1)
  if (idle === undefined) {
    throw new Error('the log holds no session.status_idle')
  }
  return idle
}

/** The one call the log holds, whichever turn wrote it. */
function callOf(log: readonly StoredEvent[]): Extract<StoredEvent, { type: 'agent.tool_use' }> {
  const call = of(log, EVENT_TYPES.agentToolUse)[0]
  if (call === undefined) {
    throw new Error('the log holds no agent.tool_use')
  }
  return call
}

/** Answer a call the way the route does: the confirmation lands in the log, processed. */
async function confirm(
  store: InMemorySessionStore,
  sessionId: SessionId,
  toolUseId: string,
  confirmation: {
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
): Promise<void> {
  await store.appendEvents(sessionId, [
    {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: toolUseId as EventId,
      ...confirmation,
    },
  ])
}

describe('what the log says about a pause', () => {
  it('reads a waiting call off the log, and never a call that is answered', () => {
    const waiting = makeAgentToolUse('echo', {}, { evaluated_permission: 'ask' })
    const allowed = makeAgentToolUse('echo', {}, { evaluated_permission: 'allow' })
    const answered = makeAgentToolUse('echo', {}, { evaluated_permission: 'ask' })
    const result = { ...answered, type: EVENT_TYPES.agentToolResult, tool_use_id: answered.id }
    const log = [waiting, allowed, answered, result] as unknown as StoredEvent[]

    expect(awaitingUser(log).map((call) => call.id)).toEqual([waiting.id])
  })

  it('takes the newest confirmation for a call, and the tools a session remembers', () => {
    const call = makeAgentToolUse('echo', {}, { evaluated_permission: 'ask' })
    const other = makeAgentToolUse('browse', {}, { evaluated_permission: 'ask' })
    const first = makeToolConfirmation(call, { result: 'allow', remember: 'once' })
    const second = makeToolConfirmation(call, { result: 'allow', remember: 'session' })
    const always = makeToolConfirmation(other, { result: 'allow', remember: 'always' })
    const log = [call, other, first, second, always] as unknown as StoredEvent[]

    const confirmations = confirmationsByCall(log)
    expect(confirmations.get(call.id)?.id).toBe(second.id)
    expect([...sessionApprovedTools(log)].sort()).toEqual(['browse', 'echo'])
  })

  it('does not remember a denial, and does not read one as an approval', () => {
    const call = makeAgentToolUse('echo', {}, { evaluated_permission: 'ask' })
    const denied = makeToolConfirmation(call, { result: 'deny', deny_message: 'not now' })
    const log = [call, denied] as unknown as StoredEvent[]

    expect(sessionApprovedTools(log).size).toBe(0)
    expect(confirmationsByCall(log).get(call.id)?.result).toBe('deny')
  })

  it('reads the same pause back from a replay of the log', () => {
    const call = makeAgentToolUse(ASK_USER_TOOL_NAME, QUESTIONS, { evaluated_permission: 'ask' })
    const confirmation = makeToolConfirmation(call, { result: 'allow', answers: ANSWERS })
    const paused = [makeUserMessage('deploy it'), call] as unknown as StoredEvent[]
    const answered: StoredEvent[] = [...paused, confirmation]

    // A pause is written down, not held: a fresh read of the log rebuilds the question and the
    // answer that settled it, with nothing kept beside them.
    expect(awaitingUser(paused).map((waiting) => waiting.id)).toEqual([call.id])
    expect(awaitingUser(answered).map((waiting) => waiting.id)).toEqual([call.id])
    expect(answeredWaiting(answered).map((waiting) => waiting.id)).toEqual([call.id])
    expect(confirmationsByCall(answered).get(call.id)?.answers?.[0]?.labels).toEqual(['staging'])
  })

  it('leaves a call waiting when nothing has answered it, and calls an answered one lost', () => {
    const waiting = makeAgentToolUse('echo', {}, { evaluated_permission: 'ask' })
    const approved = makeAgentToolUse('echo', {}, { evaluated_permission: 'ask' })
    const crashed = makeAgentToolUse('echo', {}, { evaluated_permission: 'allow' })
    const confirmation = makeToolConfirmation(approved, { result: 'allow' })
    const log = [waiting, approved, crashed, confirmation] as unknown as StoredEvent[]

    // Nothing is lost while the user has not been asked; an approval nobody finished, and a
    // call the loop never ran, are both executions this brain did not see.
    expect(lostExecutions(log).map((call) => call.id)).toEqual([approved.id, crashed.id])
  })

  it('knows which calls a predicate means, whatever the tool is', () => {
    expect(waitsForUser('ask', true, 'echo')).toBe(true)
    expect(waitsForUser('allow', true, ASK_USER_TOOL_NAME)).toBe(true)
    expect(waitsForUser('deny', true, 'echo')).toBe(false)
    // A tool this deployment does not register waits for nothing: it cannot be called at all.
    expect(waitsForUser('ask', false, 'echo')).toBe(false)
    expect(waitsForUser('allow', false, ASK_USER_TOOL_NAME)).toBe(false)
  })
})

describe('the ask policy', () => {
  /** A session whose model calls `echo` in its first step and answers in its second. */
  async function asked(): Promise<{
    readonly store: Awaited<ReturnType<typeof newSession>>['store']
    readonly sessionId: Awaited<ReturnType<typeof newSession>>['sessionId']
    readonly tool: ToolDefinition<{ text: string }>
    readonly run: ReturnType<typeof vi.fn>
    readonly model: ReturnType<typeof mockModel>
  }> {
    const { store, sessionId } = await newSession([message('tidy up')])
    const { tool, run } = echo()
    const model = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'tidy up' } }] },
      { text: ['Done.'] },
      // The edit below restarts the chat, so the model asks for the tool again — this is its
      // call on the rewritten message, and the reply that follows it.
      { toolCalls: [{ name: 'echo', input: { text: 'tidy up again' } }] },
      { text: ['Done again.'] },
    )
    return { store, sessionId, tool, run, model }
  }

  it('stops the turn on a call it may not run, and runs it once the user allows it', async () => {
    const { store, sessionId, tool, run, model } = await asked()

    const paused = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    // Nothing ran, nothing was answered, and the turn named the call it waits on.
    expect(paused).toEqual({ outcome: 'paused' })
    expect(run).not.toHaveBeenCalled()
    let log = await logOf(store, sessionId)
    const call = callOf(log)
    expect(call).toMatchObject({ evaluated_permission: 'ask', name: 'echo' })
    expect(of(log, EVENT_TYPES.agentToolResult)).toEqual([])
    expect(idleOf(log).stop_reason).toEqual({
      type: 'requires_action',
      event_ids: [call.id],
    })

    // The user allows it. The turn that starts runs the call, stores its answer and asks the
    // model again — the ordinary tool step, one confirmation later.
    await confirm(store, sessionId, call.id, { result: 'allow' })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toEqual({ text: 'tidy up' })
    log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult)[0]).toMatchObject({
      tool_use_id: call.id,
      content: [{ type: 'text', text: 'tidy up' }],
      is_error: false,
    })
    // The request the answer bought carries it, and the turn ends on the model's reply.
    expect(textOf(of(log, EVENT_TYPES.agentMessage).at(-1))).toBe('Done.')
    expect(idleOf(log).stop_reason).toEqual({ type: 'end_turn' })
  })

  it('answers a denial with the user’s own words, without running anything', async () => {
    const { store, sessionId, tool, run, model } = await asked()
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    const call = callOf(await logOf(store, sessionId))

    await confirm(store, sessionId, call.id, {
      result: 'deny',
      deny_message: 'I would rather not touch production.',
    })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult).at(-1)).toMatchObject({
      tool_use_id: call.id,
      is_error: true,
    })
    expect(resultText(of(log, EVENT_TYPES.agentToolResult).at(-1))).toBe(
      'The user denied this: I would rather not touch production.',
    )
  })

  it('runs every later call of a tool the user remembered for the session', async () => {
    const { store, sessionId, tool, run, model } = await asked()
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    const call = callOf(await logOf(store, sessionId))
    await confirm(store, sessionId, call.id, { result: 'allow', remember: 'session' })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    expect(run).toHaveBeenCalledTimes(1)

    // The next message in the same chat: the tool is called again, and the confirmation in the
    // log is the whole of what allows it — no pause, and the call is evaluated under `allow`.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'and again' }] },
    ])
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).toHaveBeenCalledTimes(2)
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolUse).at(-1)).toMatchObject({
      evaluated_permission: 'allow',
    })
    expect(idleOf(log).stop_reason).toEqual({ type: 'end_turn' })
  })

  it('remembers nothing beyond the call it answers when the user says `once`', async () => {
    const { store, sessionId, tool, run, model } = await asked()
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    const call = callOf(await logOf(store, sessionId))
    await confirm(store, sessionId, call.id, { result: 'allow', remember: 'once' })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    expect(run).toHaveBeenCalledTimes(1)

    // The next message asks for the tool again — and the approval was for one call, so the
    // turn pauses exactly as the first one did.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'and again' }] },
    ])
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'paused' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(idleOf(await logOf(store, sessionId)).stop_reason).toMatchObject({
      type: 'requires_action',
    })
  })

  it('forgets a remembered approval when an edit rewinds past it', async () => {
    const { store, sessionId, tool, run, model } = await asked()
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    const log = await logOf(store, sessionId)
    const call = callOf(log)
    await confirm(store, sessionId, call.id, { result: 'allow', remember: 'session' })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    expect(run).toHaveBeenCalledTimes(1)

    // The reader edits their message: everything from it on — the call, its approval, the
    // reply — is superseded, and the chat starts again from the edit.
    const rewritten = await logOf(store, sessionId)
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionRewind, from_seq: rewritten[0]?.seq ?? 0 },
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'tidy up again' }] },
    ])

    const replay = await logOf(store, sessionId)
    expect(replay.some((event) => event.type === EVENT_TYPES.userToolConfirmation)).toBe(false)
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    // The approval went with the branch: the call pauses again, exactly as the first one did.
    expect(outcome).toEqual({ outcome: 'paused' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(idleOf(await logOf(store, sessionId)).stop_reason).toMatchObject({
      type: 'requires_action',
    })
  })

  it('runs the calls it may and pauses on the ones it may not, in one step', async () => {
    const { store, sessionId } = await newSession([message('both')])
    const allowed = echo()
    const askedTool = echo()
    const model = mockModel(
      {
        toolCalls: [
          { name: 'read', input: { text: 'read me' } },
          { name: 'write', input: { text: 'write me' } },
        ],
      },
      { text: ['Fine.'] },
    )
    const tools = createToolRegistry([
      { ...allowed.tool, name: 'read' },
      { ...askedTool.tool, name: 'write' },
    ])

    const paused = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools,
      toolSettings: () => ({
        read: { enabled: true, permission: 'allow' },
        write: { enabled: true, permission: 'ask' },
      }),
    })

    expect(paused).toEqual({ outcome: 'paused' })
    expect(allowed.run).toHaveBeenCalledTimes(1)
    expect(askedTool.run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const [read, write] = of(log, EVENT_TYPES.agentToolUse)
    expect(read).toMatchObject({ evaluated_permission: 'allow' })
    expect(write).toMatchObject({ evaluated_permission: 'ask' })
    // The one it could run is answered; the one it may not is not — and is what the turn names.
    expect(of(log, EVENT_TYPES.agentToolResult).map((result) => result.tool_use_id)).toEqual([
      read?.id,
    ])
    expect(idleOf(log).stop_reason).toEqual({
      type: 'requires_action',
      event_ids: [write?.id],
    })
  })

  it('answers several waiting calls one at a time, keeping the ones nobody has answered', async () => {
    const { store, sessionId } = await newSession([message('both')])
    const first = echo()
    const second = echo()
    const model = mockModel(
      {
        toolCalls: [
          { name: 'one', input: { text: 'first' } },
          { name: 'two', input: { text: 'second' } },
        ],
      },
      { text: ['Fine.'] },
    )
    const tools = createToolRegistry([
      { ...first.tool, name: 'one' },
      { ...second.tool, name: 'two' },
    ])
    const ask: ToolSettings = {
      one: { enabled: true, permission: 'ask' },
      two: { enabled: true, permission: 'ask' },
    }
    const turn = (): ReturnType<typeof runTurn> =>
      runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        tools,
        toolSettings: () => ask,
      })

    await turn()
    const log = await logOf(store, sessionId)
    const [one, two] = of(log, EVENT_TYPES.agentToolUse)
    expect(idleOf(log).stop_reason).toEqual({
      type: 'requires_action',
      event_ids: [one?.id, two?.id],
    })

    await confirm(store, sessionId, one?.id ?? '', { result: 'allow' })
    expect(await turn()).toEqual({ outcome: 'paused' })
    expect(first.run).toHaveBeenCalledTimes(1)
    expect(second.run).not.toHaveBeenCalled()
    const afterOne = await logOf(store, sessionId)
    expect(of(afterOne, EVENT_TYPES.agentToolResult).map((result) => result.tool_use_id)).toEqual([
      one?.id,
    ])
    expect(idleOf(afterOne).stop_reason).toEqual({
      type: 'requires_action',
      event_ids: [two?.id],
    })

    await confirm(store, sessionId, two?.id ?? '', { result: 'allow' })
    expect(await turn()).toEqual({ outcome: 'idle' })
    expect(second.run).toHaveBeenCalledTimes(1)
    const done = await logOf(store, sessionId)
    expect(of(done, EVENT_TYPES.agentToolResult)).toHaveLength(2)
    expect(textOf(of(done, EVENT_TYPES.agentMessage).at(-1))).toBe('Fine.')
  })
})

describe('ask_user', () => {
  /** A session whose model asks the user a question. */
  async function asking(input: unknown = QUESTIONS): Promise<{
    readonly store: Awaited<ReturnType<typeof newSession>>['store']
    readonly sessionId: Awaited<ReturnType<typeof newSession>>['sessionId']
    readonly run: ReturnType<typeof vi.fn>
    readonly model: ReturnType<typeof mockModel>
    readonly tools: ReturnType<typeof createToolRegistry>
  }> {
    const { store, sessionId } = await newSession([message('deploy it')])
    const { tool, run } = askUser()
    const model = mockModel(
      { toolCalls: [{ name: ASK_USER_TOOL_NAME, input }] },
      { text: ['Thanks.'] },
    )
    return { store, sessionId, run, model, tools: createToolRegistry([tool]) }
  }

  it('pauses on a call whatever the policy says, and writes the answers as its result', async () => {
    const { store, sessionId, run, model, tools } = await asking()

    // No settings resolver at all: the pause is the tool's own, not a policy's.
    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        tools,
      }),
    ).toEqual({ outcome: 'paused' })

    expect(run).not.toHaveBeenCalled()
    const paused = await logOf(store, sessionId)
    const call = callOf(paused)
    expect(call).toMatchObject({ name: ASK_USER_TOOL_NAME, evaluated_permission: 'ask' })
    expect(idleOf(paused).stop_reason).toEqual({
      type: 'requires_action',
      event_ids: [call.id],
    })

    await confirm(store, sessionId, call.id, { result: 'allow', answers: ANSWERS })
    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        tools,
      }),
    ).toEqual({ outcome: 'idle' })

    // The answers are the result — the tool never ran — and the model was told them.
    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult).at(-1)
    expect(result).toMatchObject({ tool_use_id: call.id, is_error: false })
    expect(resultText(result)).toBe(
      [
        'Which environment should I deploy to?: staging',
        'Anything else I should know?: the release is on Thursday',
        'Shall I ship it?: Yes',
      ].join('\n'),
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('answers a denial as a question the user would not answer', async () => {
    const { store, sessionId, model, tools } = await asking()
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools,
    })
    const call = callOf(await logOf(store, sessionId))
    await confirm(store, sessionId, call.id, { result: 'deny' })

    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        tools,
      }),
    ).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult).at(-1)).toMatchObject({ is_error: true })
    expect(resultText(of(log, EVENT_TYPES.agentToolResult).at(-1))).toBe('The user denied this.')
  })

  it('does not store answers that do not fit the questions the call asked', async () => {
    const { store, sessionId, model, tools } = await asking()
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools,
    })
    const call = callOf(await logOf(store, sessionId))
    // The route refuses these before they are stored (`apps/server`), so this is the brain's own
    // guard against a log assembled another way: a result the model cannot read is never written.
    await confirm(store, sessionId, call.id, {
      result: 'allow',
      answers: [
        { question: 'Which environment should I deploy to?', labels: ['somewhere else'] },
        { question: 'Anything else I should know?', text: 'no' },
        { question: 'Shall I ship it?', confirmed: true },
      ],
    })

    expect(
      await runTurn(sessionId, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
        tools,
      }),
    ).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult).at(-1)
    expect(result).toMatchObject({ tool_use_id: call.id, is_error: true })
    expect(resultText(result)).toContain('Invalid answers for ask_user:')
  })

  it('tells the model its questions were malformed instead of pausing on them', async () => {
    const { store, sessionId, run, model, tools } = await asking({ questions: [] })

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools,
    })

    // The turn ran on: the call was answered with what was wrong, and the model could ask again.
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ is_error: true, tool_use_id: callOf(log).id })
    expect(resultText(result)).toContain('Invalid input for ask_user:')
    expect(idleOf(log).stop_reason).toEqual({ type: 'end_turn' })
    // The model was asked twice: the answer bought a second request, as any tool result does.
    expect(eventTypes(log).filter((type) => type === EVENT_TYPES.modelRequestStart)).toHaveLength(2)
  })
})

describe('a pause and the rest of the chat', () => {
  /** A session paused on an `ask`-policy call, and the pieces a test drives it with. */
  async function paused(): Promise<{
    readonly store: Awaited<ReturnType<typeof newSession>>['store']
    readonly sessionId: Awaited<ReturnType<typeof newSession>>['sessionId']
    readonly run: ReturnType<typeof vi.fn>
    readonly model: ReturnType<typeof mockModel>
    readonly callId: string
  }> {
    const { store, sessionId } = await newSession([message('tidy up')])
    const { tool, run } = echo()
    const model = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'tidy up' } }] },
      { text: ['Right away.'] },
    )
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([tool]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })
    const call = callOf(await logOf(store, sessionId))
    return { store, sessionId, run, model, callId: call.id }
  }

  it('resolves every waiting call when the user sends a message instead', async () => {
    const { store, sessionId, run, model } = await paused()

    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'never mind' }] },
    ])
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([{ ...echo().tool, name: 'echo' }]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    // The call was resolved as one the user never answered, nothing ran, and the message the
    // user sent was answered by the next request.
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ is_error: true })
    expect(resultText(result)).toBe(RESOLVED_BY_MESSAGE)
    expect(textOf(of(log, EVENT_TYPES.agentMessage).at(-1))).toBe('Right away.')
    expect(eventTypes(log)).toContain(EVENT_TYPES.userMessage)
    expect(idleOf(log).stop_reason).toEqual({ type: 'end_turn' })
  })

  it('resolves them the same way when the user interrupts instead', async () => {
    const { store, sessionId, run, model } = await paused()

    await store.appendEvents(sessionId, [{ type: EVENT_TYPES.userInterrupt }])
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([{ ...echo().tool, name: 'echo' }]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'interrupted' })
    const log = await logOf(store, sessionId)
    expect(resultText(of(log, EVENT_TYPES.agentToolResult)[0])).toBe(RESOLVED_BY_MESSAGE)
    expect(of(log, EVENT_TYPES.userInterrupt)[0]?.processed_at).not.toBeNull()
    expect(idleOf(log).consumes).toEqual([of(log, EVENT_TYPES.userInterrupt)[0]?.id])
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps waiting when the brain that started the turn is gone', async () => {
    const { store, sessionId, run, model } = await paused()

    // An open turn nobody closed: the next brain inherits it, and a call waiting on the user
    // has lost nothing — so it waits again rather than being answered as lost.
    await store.appendEvents(sessionId, [statusRunning()])
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([{ ...echo().tool, name: 'echo' }]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    expect(outcome).toEqual({ outcome: 'paused' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.agentToolResult)).toEqual([])
    expect(idleOf(log).stop_reason).toMatchObject({ type: 'requires_action' })
  })

  it('answers a call approved but never finished as an execution that was lost', async () => {
    const { store, sessionId, run, model, callId } = await paused()

    await confirm(store, sessionId, callId, { result: 'allow' })
    await store.appendEvents(sessionId, [statusRunning()])
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([{ ...echo().tool, name: 'echo' }]),
      toolSettings: () => ({ echo: { enabled: true, permission: 'ask' } }),
    })

    // Whatever the approval allowed may already have run, so the call is never run again.
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result).toMatchObject({ tool_use_id: callId, is_error: true })
    expect(resultText(result)).toContain('execution lost')
    expect(textOf(of(log, EVENT_TYPES.agentMessage).at(-1))).toBe('Right away.')
  })
})
