import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  EVENT_TYPES,
  MESSAGE_PARENT_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  newTaskId,
  ulid,
} from '@openharness/protocol'
import type {
  EventId,
  Session,
  SessionId,
  SessionTaskStartedEvent,
  StoredEvent,
  TaskId,
} from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  EMPTY_TURN_RESULT,
  childTurnDelivery,
  childTaskParent,
  offeredSubagentTools,
  stopOrphanedTasks,
  type SubagentRuntime,
} from './agents'
import { logOf, message, newSession } from './testing/harness'
import { apiCallError, mockModel, readPrompt, resolveTestCredential } from './testing/mock-model'
import type { SubagentParent, SubagentTypeResolver } from './subagent'
import {
  GENERAL_PURPOSE_DESCRIPTION,
  GENERAL_PURPOSE_TYPE,
  SUBAGENT_SYSTEM_PROMPT,
  withSubagentPrompt,
} from './subagent'
import { deliverableNotifications } from './tasks'
import { runTurn } from './turn'

/**
 * Subagents as the loop runs them (epic #340, S5/S6/S7; issue #344).
 *
 * The parent side is exercised through `runTurn` against a real store and a scripted model that
 * calls the tools, so what is asserted is what the log holds: a child is a session with a
 * parent, a task and a prompt of its own; a start, a message and a stop are events; and what a
 * child's turn owes its parent is written once, keyed by the turn.
 *
 * The resolver is a stub — whether a mode can be used is the server's question (#342) — and the
 * runtime is the three things a deployment answers: the types, and S6's two limits.
 */

/** The type the stub resolver knows beside `general-purpose`. */
const RESEARCHER = { name: 'researcher', description: 'Reads things and reports.' }

/** A resolver that answers the two types, and refuses everything else with a sentence. */
function types(overrides: Partial<SubagentTypeResolver> = {}): SubagentTypeResolver {
  return {
    list: () =>
      Promise.resolve([
        { name: GENERAL_PURPOSE_TYPE, description: GENERAL_PURPOSE_DESCRIPTION },
        RESEARCHER,
      ]),
    resolve: (_ownerId, name, parent) =>
      Promise.resolve(
        name === RESEARCHER.name
          ? {
              ok: true,
              type: {
                ...RESEARCHER,
                model: 'anthropic/claude-haiku-4-5',
                reasoningEffort: 'low',
                systemPromptAddition: 'Be terse.',
                modeId: null,
                toolOverride: null,
                tools: [],
                mcpServers: [],
              },
            }
          : name === GENERAL_PURPOSE_TYPE
            ? {
                ok: true,
                type: {
                  name: GENERAL_PURPOSE_TYPE,
                  description: GENERAL_PURPOSE_DESCRIPTION,
                  model: parent.model,
                  reasoningEffort: parent.reasoningEffort,
                  systemPromptAddition: null,
                  modeId: parent.modeId,
                  toolOverride: parent.toolOverride,
                  tools: [],
                  mcpServers: [],
                },
              }
            : { ok: false, message: `There is no subagent type named \`${name}\`.` },
      ),
    ...overrides,
  }
}

/** A deployment's answer, with the signals it sent recorded. */
function runtime(overrides: Partial<SubagentRuntime> = {}): {
  readonly runtime: SubagentRuntime
  readonly signal: ReturnType<typeof vi.fn>
} {
  const signal = vi.fn()
  return {
    runtime: { types: types(), maxDepth: 3, maxLiveTasks: 10, signal, ...overrides },
    signal,
  }
}

/** The `agent` call a scripted turn makes. */
const START = {
  name: AGENT_TOOL_NAME,
  input: { type: RESEARCHER.name, description: 'Check the rewind path', prompt: 'Read it.' },
}

/** Every stored event of one type, in order, narrowed to that kind. */
function of<T extends StoredEvent['type']>(
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

/** The task starts a log holds, by id. */
function starts(log: readonly StoredEvent[]): Map<TaskId, SessionTaskStartedEvent> {
  return new Map(of(log, EVENT_TYPES.sessionTaskStarted).map((event) => [event.task_id, event]))
}

/** The child session a task started, read back from the store. */
async function childOf(
  store: InMemorySessionStore,
  log: readonly StoredEvent[],
  sessionId: SessionId,
): Promise<Session> {
  const start = of(log, EVENT_TYPES.sessionTaskStarted)[0]
  const child = await store.getSessionUnscoped(start?.child_session_id ?? sessionId)
  if (child === null) {
    throw new Error('the call started no child session')
  }
  return child
}

/** Say something to a session, as a client would — a turn with nothing queued is a no-op. */
async function say(store: InMemorySessionStore, sessionId: SessionId, text: string): Promise<void> {
  await store.appendEvents(sessionId, [message(text)])
}

/** A turn on `sessionId`, with a subagent runtime wired and a registry that holds the five. */
async function turn(
  store: InMemorySessionStore,
  sessionId: SessionId,
  scripts: Parameters<typeof mockModel>,
  subagents: SubagentRuntime,
  tools: readonly ToolDefinition[] = [],
) {
  const model = mockModel(...scripts)
  const outcome = await runTurn(sessionId, {
    store,
    model: model.factory,
    resolveCredential: resolveTestCredential,
    subagents,
    tools: tools.length === 0 ? undefined : createToolRegistry(tools),
  })
  return { outcome, model }
}

describe('the tools a session is offered (S5/S6; #344)', () => {
  it('offers the parent side under the depth cap, and message_parent only to a child', () => {
    const { runtime: deployment } = runtime()
    const parent = 'sesn_parent' as SessionId
    const top = { depth: 0, parent_session_id: null }
    const nested = { depth: 2, parent_session_id: parent }
    const deepest = { depth: 3, parent_session_id: parent }

    expect(offeredSubagentTools(top, deployment)).toEqual([
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
    ])
    // A child at the cap is offered the one tool that reaches up and nothing that starts work:
    // nesting is allowed and bounded, and the bound is what a tree stops at.
    expect(offeredSubagentTools(nested, deployment)).toContain(AGENT_TOOL_NAME)
    expect(offeredSubagentTools(deepest, deployment)).toEqual([MESSAGE_PARENT_TOOL_NAME])
  })

  it('offers them through a turn, with the types listed in the agent description', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { model } = await turn(store, sessionId, [{ text: ['Done.'] }], deployment)

    const offered = (model.calls[0]?.tools ?? []).map((tool) => tool.name)
    expect(offered).toEqual(
      expect.arrayContaining([
        AGENT_TOOL_NAME,
        AGENT_MESSAGE_TOOL_NAME,
        TASK_WAIT_TOOL_NAME,
        AGENT_STOP_TOOL_NAME,
      ]),
    )
    // A top-level chat has nobody above it, so the child's one tool is not offered.
    expect(offered).not.toContain(MESSAGE_PARENT_TOOL_NAME)
    // The list is part of the `agent` tool's own description, which is what the model chooses
    // from — and it is the resolver's answer, asked for this owner.
    const agent = (model.calls[0]?.tools ?? []).find((tool) => tool.name === AGENT_TOOL_NAME)
    expect(JSON.stringify(agent)).toContain(RESEARCHER.description)
    expect(JSON.stringify(agent)).toContain(GENERAL_PURPOSE_TYPE)
  })

  it('leaves the registry the host built exactly as it was when no runtime is wired', async () => {
    // A deployment with no subagents must not lose a tool of one of those names: the test hooks
    // register `agent_wait` for the mock model without a runtime, and the loop still recognises
    // it there (A3's own tests are the other half of this).
    const { store, sessionId } = await newSession([message('hi')])
    const wait: ToolDefinition = {
      name: TASK_WAIT_TOOL_NAME,
      description: 'Wait.',
      inputSchema: z.object({}),
      permission: 'allow',
      run: () => textResult('answered by the log'),
    }
    const model = mockModel({ text: ['Done.'] })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([wait]),
    })
    expect((model.calls[0]?.tools ?? []).map((tool) => tool.name)).toContain(TASK_WAIT_TOOL_NAME)
  })
})

describe('starting a helper (S3/S4/S5; #344)', () => {
  it('creates a child session and answers its handle at once', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { outcome, model } = await turn(
      store,
      sessionId,
      [{ toolCalls: [START] }, { text: ['Started it.'] }],
      deployment,
    )
    expect(outcome).toEqual({ outcome: 'idle' })

    const log = await logOf(store, sessionId)
    const started = of(log, EVENT_TYPES.sessionTaskStarted)[0]
    expect(started).toMatchObject({
      kind: 'subagent',
      task_type: RESEARCHER.name,
      description: 'Check the rewind path',
    })
    expect(of(log, EVENT_TYPES.sessionTaskStatus)[0]?.status).toBe('running')

    // A child is a real session: owned by the parent's owner, parented, one level deeper, not a
    // chat somebody is typing into, and running what its type resolved to.
    const child = await childOf(store, log, sessionId)
    expect(child).toMatchObject({
      owner_id: child.owner_id,
      parent_session_id: sessionId,
      parent_task_id: started?.task_id,
      root_session_id: sessionId,
      depth: 1,
      interactive: false,
      model: { id: 'anthropic/claude-haiku-4-5' },
    })
    // No history is inherited: the prompt is the whole of what the child has (S3).
    const childLog = await logOf(store, child.id)
    expect(childLog.map((event) => event.type)).toEqual([EVENT_TYPES.userMessage])
    expect(childLog[0]).toMatchObject({
      content: [{ type: 'text', text: 'Read it.' }],
      processed_at: null,
    })

    // The handle is the call's result, and the child is woken.
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(resultText(result)).toContain(started?.task_id ?? '')
    expect(resultText(result)).toContain(RESEARCHER.name)
    expect(result?.is_error).not.toBe(true)
    expect(signal).toHaveBeenCalledWith(child.id, 'work')
    // The description the model read is the resolver's answer, and the tool list says the types.
    expect(JSON.stringify(model.calls[0]?.tools ?? [])).toContain(RESEARCHER.description)
  })

  it('answers an unknown type with the resolver’s own sentence, and starts nothing', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(
      store,
      sessionId,
      [
        { toolCalls: [{ name: AGENT_TOOL_NAME, input: { ...START.input, type: 'nope' } }] },
        { text: ['I will do it myself.'] },
      ],
      deployment,
    )

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(true)
    expect(resultText(result)).toBe('There is no subagent type named `nope`.')
    expect(of(log, EVENT_TYPES.sessionTaskStarted)).toEqual([])
    expect(signal).not.toHaveBeenCalled()
  })

  it('refuses a start when the chat already has the limit of live helpers (S6)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime({ maxLiveTasks: 1 })
    // One live descendant: a child with a queued prompt, which is work a turn has not started.
    const first = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      parentSessionId: sessionId,
      parentTaskId: newTaskId(),
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    expect(await store.countLiveDescendants(sessionId)).toBe(1)

    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Cannot.'] }], deployment)

    const log = await logOf(store, sessionId)
    const result = of(log, EVENT_TYPES.agentToolResult)[0]
    expect(result?.is_error).toBe(true)
    expect(resultText(result)).toContain('the limit')
    expect(of(log, EVENT_TYPES.sessionTaskStarted)).toEqual([])
    expect(await store.listDescendants(sessionId, { ownerId: 'user_brain_tests' })).toEqual([
      first.id,
    ])
  })
})

describe('steering a helper (S5; #344)', () => {
  it('sends a running child a message and wakes it', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Started.'] }], deployment)
    const log = await logOf(store, sessionId)
    const taskId = of(log, EVENT_TYPES.sessionTaskStarted)[0]?.task_id as TaskId
    const child = await childOf(store, log, sessionId)

    // The tool is offered to this chat, and the call is a `user.message` in the child — which is
    // what steering is: the loop claims it in the request that answers it.
    await say(store, sessionId, 'check on it')
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [{ name: AGENT_MESSAGE_TOOL_NAME, input: { task_id: taskId, text: 'go on' } }],
        },
        { text: ['Told it.'] },
      ],
      deployment,
    )

    const after = await logOf(store, sessionId)
    const told = resultText(of(after, EVENT_TYPES.agentToolResult).at(-1))
    expect(told).toContain(taskId)
    const childLog = await logOf(store, child.id)
    expect(childLog.at(-1)).toMatchObject({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'go on' }],
    })
    expect(signal).toHaveBeenCalledWith(child.id, 'work')
    // The child's context is intact: the prompt it was started with is still there above it.
    expect(of(childLog, EVENT_TYPES.userMessage).map((event) => event.content[0]?.text)).toEqual([
      'Read it.',
      'go on',
    ])
  })

  it('answers an unknown or foreign task id with an is_error, and writes nothing (S5)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const foreign = newTaskId()
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [
            { name: AGENT_MESSAGE_TOOL_NAME, input: { task_id: foreign, text: 'hi' } },
            { name: AGENT_STOP_TOOL_NAME, input: { task_id: foreign } },
          ],
        },
        { text: ['Cannot.'] },
      ],
      deployment,
    )

    const log = await logOf(store, sessionId)
    const results = of(log, EVENT_TYPES.agentToolResult)
    expect(results.map((result) => result.is_error)).toEqual([true, true])
    for (const result of results) {
      expect(resultText(result)).toContain(foreign)
    }
    expect(of(log, EVENT_TYPES.sessionTaskStatus)).toEqual([])
  })
})

describe('stopping a helper (S5/S7; #344)', () => {
  it('marks the task stopped and interrupts the child', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    await turn(store, sessionId, [{ toolCalls: [START] }, { text: ['Started.'] }], deployment)
    const log = await logOf(store, sessionId)
    const taskId = of(log, EVENT_TYPES.sessionTaskStarted)[0]?.task_id as TaskId
    const child = await childOf(store, log, sessionId)

    await say(store, sessionId, 'stop it')
    await turn(
      store,
      sessionId,
      [
        { toolCalls: [{ name: AGENT_STOP_TOOL_NAME, input: { task_id: taskId } }] },
        { text: ['Stopped.'] },
      ],
      deployment,
    )

    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'stopped',
    )
    expect(signal).toHaveBeenCalledWith(child.id, 'interrupt')
  })
})

describe('a child reaching its parent (S4/S5; #344)', () => {
  /** A child session of `parent`, with a prompt of its own, as `agent` would have made one. */
  async function childOfParent(
    store: InMemorySessionStore,
    parent: SessionId,
    prompt = 'do the thing',
  ): Promise<{ child: Session; taskId: TaskId }> {
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: parent,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      system: 'Be a helper.',
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: prompt }] },
      ],
    })
    await store.appendEvents(parent, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
      { type: EVENT_TYPES.sessionTaskStatus, task_id: taskId, status: 'running' },
    ])
    return { child, taskId }
  }

  it('offers a child message_parent, and runs it as a note the parent is told about', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    const { model } = await turn(
      store,
      child.id,
      [
        { toolCalls: [{ name: MESSAGE_PARENT_TOOL_NAME, input: { text: 'half way' } }] },
        { text: ['Noted.'] },
      ],
      deployment,
    )
    const offered = (model.calls[0]?.tools ?? []).map((tool) => tool.name)
    expect(offered).toContain(MESSAGE_PARENT_TOOL_NAME)
    // A child under the cap is offered the parent's tools as well (S6).
    expect(offered).toContain(AGENT_TOOL_NAME)

    // The note is a `message` notification in the parent's log, queued for its model.
    const parentLog = await logOf(store, sessionId)
    const note = of(parentLog, EVENT_TYPES.sessionTaskNotification).find(
      (event) => event.kind === 'message',
    )
    expect(note).toMatchObject({
      task_id: taskId,
      kind: 'message',
      text: 'half way',
      processed_at: null,
    })
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')
    // And the child's own turn: it says it is working, and its own log holds the note's call.
    expect(of(await logOf(store, child.id), EVENT_TYPES.agentToolResult).map(resultText)).toEqual([
      'The note was sent to the chat that started you.',
    ])
  })

  it('delivers a finished turn as a result, keyed by the turn, and moves the task to idle', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    await turn(store, child.id, [{ text: ['The rewind drops the tail.'] }], deployment)

    const parentLog = await logOf(store, sessionId)
    // The status the child's turn start wrote, then the news its end did.
    expect(of(parentLog, EVENT_TYPES.sessionTaskStatus).map((event) => event.status)).toEqual([
      'running',
      'running',
      'idle',
    ])
    const notification = of(parentLog, EVENT_TYPES.sessionTaskNotification)[0]
    const childLog = await logOf(store, child.id)
    const idle = of(childLog, EVENT_TYPES.sessionStatusIdle)[0]
    expect(notification).toMatchObject({
      task_id: taskId,
      kind: 'result',
      text: 'The rewind drops the tail.',
      processed_at: null,
      source_key: `${child.id}:${idle?.seq}`,
    })
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')
  })

  it('announces a failed turn as failed, with what the provider said', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child, taskId } = await childOfParent(store, sessionId)

    await turn(store, child.id, [{ failWith: apiCallError(400, 'the model refused') }], deployment)

    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]).toMatchObject(
      {
        task_id: taskId,
        kind: 'failed',
        text: 'the model refused',
      },
    )
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'failed',
    )
  })

  it('announces a turn that said nothing at all, so the parent is not left waiting', async () => {
    // A turn can end with no reply: a step that only called a tool, and a request that streamed
    // no text. The parent still has to be told the helper stopped working — the announcement is
    // what tells it — so the news is a result that says so.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    const echo: ToolDefinition<{ text: string }> = {
      name: 'echo',
      description: 'Echo.',
      inputSchema: z.object({ text: z.string() }),
      permission: 'allow',
      run: (input) => textResult(input.text),
    }

    await turn(
      store,
      child.id,
      [{ toolCalls: [{ name: 'echo', input: { text: 'quiet' } }] }, { text: [] }],
      deployment,
      [echo],
    )

    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]).toMatchObject(
      {
        kind: 'result',
        text: EMPTY_TURN_RESULT,
      },
    )
  })

  it('does not announce a turn that paused in a task wait of its own (S5)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)
    // The child's own child: a task it is waiting for when its turn ends.
    const grandchildTask = newTaskId()
    await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: child.id,
      parentTaskId: grandchildTask,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    const wait: ToolDefinition = {
      name: TASK_WAIT_TOOL_NAME,
      description: 'Wait.',
      inputSchema: z.object({ task_ids: z.array(z.string()).optional() }),
      permission: 'allow',
      run: () => textResult('answered by the log'),
    }

    const { outcome } = await turn(
      store,
      child.id,
      [{ toolCalls: [{ name: TASK_WAIT_TOOL_NAME, input: {} }] }],
      deployment,
      [wait],
    )

    expect(outcome.outcome).toBe('waiting')
    // The parent is told nothing: the child is still working, and the news that it stopped would
    // be a lie. Its own task stays running.
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)).toEqual([])
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).at(-1)?.status).toBe(
      'running',
    )
  })

  it('runs a child’s turn with the subagent prompt appended after its own (S2)', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const { child } = await childOfParent(store, sessionId)

    const { model } = await turn(store, child.id, [{ text: ['Done.'] }], deployment)
    expect(readPrompt(model.calls[0]!)[0]).toEqual({
      role: 'system',
      text: withSubagentPrompt('Be a helper.'),
    })
    // The check that it is the child's own prompt plus the addition, not the addition alone.
    const system = readPrompt(model.calls[0]!).find((entry) => entry.role === 'system')
    expect(system?.text).toContain('Be a helper.')
    expect(system?.text).toContain(SUBAGENT_SYSTEM_PROMPT)
  })
})

describe('what a child’s turn owes its parent (S4; #344)', () => {
  it('reads the delivery off the log: the kind, the text and the key', () => {
    const child = { id: 'sesn_child' as SessionId }
    const idle = {
      id: 'sevt_1',
      type: EVENT_TYPES.sessionStatusIdle,
      seq: 3,
      processed_at: null,
      stop_reason: { type: 'end_turn' },
    } as unknown as StoredEvent
    const reply = {
      id: 'sevt_2',
      type: EVENT_TYPES.agentMessage,
      seq: 2,
      processed_at: null,
      content: [{ type: 'text', text: 'Done.' }],
    } as unknown as StoredEvent
    const running = {
      id: 'sevt_0',
      type: EVENT_TYPES.sessionStatusRunning,
      seq: 1,
      processed_at: null,
    } as unknown as StoredEvent

    expect(childTurnDelivery([running, reply, idle], child)).toEqual({
      kind: 'result',
      text: 'Done.',
      sourceKey: 'sesn_child:3',
      status: 'idle',
    })
    // A turn that has not ended owes nothing: a log whose newest status is a running one, and
    // one with no status at all.
    expect(childTurnDelivery([running], child)).toBeNull()
    expect(childTurnDelivery([], child)).toBeNull()
    // A pause is not an end.
    const paused = {
      ...idle,
      stop_reason: { type: 'requires_action', event_ids: [] },
    } as unknown as StoredEvent
    expect(childTurnDelivery([running, reply, paused], child)).toBeNull()
  })

  it('delivers once: a second turn on an idle child writes nothing more', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    // Its turn runs and ends, and the announcement is written.
    await turn(store, child.id, [{ text: ['Done.'] }], deployment)
    const first = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)
    expect(first.map((event) => event.kind)).toEqual(['result'])

    // A second turn on the same idle child — what the store's work scan started — delivers the
    // same key again, which the store folds: no second notification, no second status.
    const statuses = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus).length
    const { outcome } = await turn(store, child.id, [{ text: ['Nothing to do.'] }], deployment)
    // A `noop`: there is nothing queued and nothing left to announce, so the turn writes nothing
    // and makes no request — which is the whole of "once".
    expect(outcome).toEqual({ outcome: 'noop' })
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)).toHaveLength(1)
    expect(of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskStatus)).toHaveLength(statuses)
  })

  it('is what an idle child with an undelivered turn wakes up for (S4; #344)', async () => {
    // The crash recovery: a child whose turn ended and whose announcement never landed is work
    // (the store's scan says so), and the turn that runs for it writes the news and nothing to
    // its own log — a `noop`, like any other turn with nothing to do.
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    // A turn that ran, ended, and died before it could say so: the prompt was claimed by the
    // request it answered, so nothing is queued and no turn is open.
    const promptId = of(await logOf(store, child.id), EVENT_TYPES.userMessage)[0]?.id
    await store.appendEvents(child.id, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'I am done.' }] },
      {
        type: EVENT_TYPES.sessionStatusIdle,
        stop_reason: { type: 'end_turn' },
        consumes: [promptId as EventId],
      },
    ])

    const { outcome, model } = await turn(store, child.id, [{ text: ['unused'] }], deployment)
    expect(outcome).toEqual({ outcome: 'noop' })
    // No model request was made: the turn had nothing to ask the model, only something to write.
    expect(model.calls).toHaveLength(0)
    const notification = of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification)[0]
    expect(notification).toMatchObject({ task_id: taskId, kind: 'result', text: 'I am done.' })
    expect(signal).toHaveBeenCalledWith(sessionId, 'work')
  })
})

describe('a rewind that took an `agent` call back (S7; #344)', () => {
  it('stops the child the call started, and drops its news', async () => {
    const { store, sessionId } = await newSession([message('start a helper')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    const child = await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'work' }] },
      ],
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        child_session_id: child.id,
        description: 'A helper',
      },
    ])
    // The reader edits the message that started it: one rewind from that message covers the
    // `session.task_started` and everything after it.
    await store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionRewind, from_seq: 1 },
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'never mind' }] },
    ])
    expect(starts(await logOf(store, sessionId)).has(taskId)).toBe(false)

    // And the child — which nobody told — finishes and says so, **after** the rewind, so its
    // news is a queued event the log really holds.
    await store.appendTaskNotification(sessionId, {
      taskId,
      kind: 'result',
      text: 'I finished before you took it back.',
      sourceKey: `${child.id}:3`,
    })

    // A turn after the edit: the orphan is stopped, and the news is not delivered — it is not
    // this chat's task any more.
    const { model } = await turn(store, sessionId, [{ text: ['Fine.'] }], deployment)
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.sessionTaskStatus).at(-1)).toMatchObject({
      task_id: taskId,
      status: 'stopped',
    })
    expect(signal).toHaveBeenCalledWith(child.id, 'interrupt')
    expect(
      readPrompt(model.calls[0]!)
        .map((entry) => JSON.stringify(entry))
        .join(''),
    ).not.toContain('I finished before you took it back.')
    expect(
      deliverableNotifications(
        of(await logOf(store, sessionId), EVENT_TYPES.sessionTaskNotification),
        starts(log),
      ),
    ).toEqual([])
  })

  it('finds no orphan when every child’s task is still in the log', async () => {
    const { store, sessionId } = await newSession([message('hi')])
    const { runtime: deployment, signal } = runtime()
    const taskId = newTaskId()
    await store.createSession(null, {
      ownerId: 'user_brain_tests',
      interactive: false,
      parentSessionId: sessionId,
      parentTaskId: taskId,
      model: { id: 'anthropic/claude-haiku-4-5' },
    })
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionTaskStarted,
        task_id: taskId,
        kind: 'subagent',
        description: 'A helper',
      },
    ])
    const session = await store.getSessionUnscoped(sessionId)
    expect(await stopOrphanedTasks(store, session as Session, deployment)).toBe(0)
    expect(signal).not.toHaveBeenCalledWith(expect.anything(), 'interrupt')
  })
})

describe('the pieces on their own (#344)', () => {
  it('reads the parent and the handle off a child session', () => {
    expect(
      childTaskParent({
        parent_session_id: 'sesn_parent' as SessionId,
        parent_task_id: 'task_1' as TaskId,
      }),
    ).toEqual({ parentSessionId: 'sesn_parent', taskId: 'task_1' })
    expect(childTaskParent({ parent_session_id: null, parent_task_id: null })).toBeNull()
    // A child no task names — A1's own children — owes nobody anything.
    expect(
      childTaskParent({ parent_session_id: 'sesn_parent' as SessionId, parent_task_id: null }),
    ).toBeNull()
  })

  it('keys a note by the child, not by a turn', () => {
    // Two notes from one child are two pieces of news: what the store makes unique is the key,
    // and a shared one would drop the second. Unique per note is all that is needed — a call is
    // never re-run after a crash, so there is no repeat to fold.
    const first = `${ulid()}`
    expect(first).not.toBe(`${ulid()}`)
  })

  it('carries what the parent is into the resolver, mode and all (S2/S6)', async () => {
    const seen: SubagentParent[] = []
    const resolver = types({
      resolve: (_owner, name, parent) => {
        seen.push(parent)
        return Promise.resolve({
          ok: true,
          type: {
            name,
            description: 'Anything.',
            model: parent.model,
            reasoningEffort: parent.reasoningEffort,
            systemPromptAddition: null,
            modeId: parent.modeId,
            toolOverride: parent.toolOverride,
            tools: [],
            mcpServers: [],
          },
        })
      },
    })
    const { store, sessionId } = await newSession([message('start', 'high')])
    const signal = vi.fn()
    await turn(
      store,
      sessionId,
      [
        {
          toolCalls: [
            {
              name: AGENT_TOOL_NAME,
              input: { type: GENERAL_PURPOSE_TYPE, description: 'Work', prompt: 'Go.' },
            },
          ],
        },
        { text: ['Started.'] },
      ],
      { types: resolver, maxDepth: 3, maxLiveTasks: 10, signal },
    )
    // The parent's own request is what a `general-purpose` child continues: the model it runs,
    // the effort in force, and no mode (the fixture chat follows none).
    expect(seen[0]).toEqual({
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'high',
      toolOverride: null,
      modeId: null,
    })
  })
})
