import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import {
  EVENT_TYPES,
  newTaskId,
  type Session,
  type SessionId,
  type StoredEvent,
} from '@openharness/protocol'
import type { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { SubagentRuntime } from './agents'
import { agentToolUse, spanEnd, spanStart, statusRunning } from './events'
import { TurnHandoff, isHandoffAbort, isTurnHandoff } from './handoff'
import { ZERO_MODEL_USAGE } from './model'
import { eventTypes, logOf, message, newSession, rawLogOf } from './testing/harness'
import { mockModel, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * A **handoff**, not an interrupt (#378, P1).
 *
 * The scheduler aborts a turn for a reason that is not the user's — a shutdown, a partition
 * given back, a lease somebody else took — and the brain must leave the turn **open** for the
 * partition's next owner instead of ending it with a partial reply and an `interrupted` span.
 * These tests pin both halves of that: what the handing-off turn writes (nothing after the
 * abort), and what the next owner does with what it finds (the inherited-turn START, a
 * `brain_lost` span end and a fresh request).
 *
 * The control is the same abort with no reason: it must still write exactly the interrupt
 * events it always did. That is the classification this change turns on.
 */

const TEST_MODEL_ID = 'anthropic/claude-sonnet-5'

/** The tool a scripted step calls. `run` is the test's — that is where a handoff can land. */
function abortingTool(controller: AbortController): ToolDefinition<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: z.object({ text: z.string() }),
    permission: 'allow',
    run: (input) => {
      controller.abort(new TurnHandoff('shutdown'))
      return textResult(input.text)
    },
  }
}

/** The span errors of a log, `null` where a request ended normally. */
function spanErrors(events: readonly StoredEvent[]): (string | null)[] {
  return events.flatMap((event) =>
    event.type === EVENT_TYPES.modelRequestEnd ? [event.error?.type ?? null] : [],
  )
}

/** The text of every `agent.message` in a log. */
function repliesIn(events: readonly StoredEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === EVENT_TYPES.agentMessage
      ? [event.content.map((block) => block.text).join('')]
      : [],
  )
}

/** A child session of `parent`, with a prompt of its own and a task the parent's log names. */
async function childOfParent(store: InMemorySessionStore, parent: SessionId): Promise<Session> {
  const taskId = newTaskId()
  const child = await store.createSession(null, {
    ownerId: 'user_brain_tests',
    interactive: false,
    parentSessionId: parent,
    parentTaskId: taskId,
    model: { id: 'anthropic/claude-haiku-4-5' },
    system: 'Be a helper.',
    initial_events: [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'do the thing' }] },
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
  return child
}

/** The runtime a child's turn needs; it starts no helpers of its own. */
const RUNTIME: SubagentRuntime = {
  types: {
    list: () => Promise.resolve([]),
    resolve: () => Promise.resolve({ ok: false, message: 'There are no types.' }),
  },
  maxDepth: 3,
  maxLiveTasks: 10,
  signal: () => undefined,
}

describe('the handoff reason', () => {
  it('recognises the marker on a signal, and nothing else', () => {
    const handoff = new AbortController()
    handoff.abort(new TurnHandoff('lease_lost'))
    expect(isHandoffAbort(handoff.signal)).toBe(true)

    const user = new AbortController()
    user.abort()
    expect(isHandoffAbort(user.signal)).toBe(false)
    expect(isHandoffAbort(new AbortController().signal)).toBe(false)
    // The tag survives a bundle boundary where `instanceof` would not.
    expect(isTurnHandoff({ kind: 'turn_handoff', cause: 'shutdown' })).toBe(true)
  })
})

describe('a turn that is handed off', () => {
  it('writes nothing after the abort and leaves the turn open (mid-stream)', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    const { factory, calls } = mockModel({
      text: ['Par', 'tial'],
      onChunk: (_chunk, index) => {
        if (index === 1) {
          controller.abort(new TurnHandoff('shutdown'))
        }
      },
    })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      signal: controller.signal,
      resolveCredential: resolveTestCredential,
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    expect(calls).toHaveLength(1)
    const raw = await rawLogOf(store, sessionId)
    // Whatever the request streamed stays exactly as it is; nothing ends the turn.
    expect(eventTypes(raw)).toContain(EVENT_TYPES.eventStart)
    expect(raw.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(false)
    expect(raw.some((event) => event.type === EVENT_TYPES.modelRequestEnd)).toBe(false)
    expect(raw.some((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toBe(false)
    // The next owner finds an open turn with a request in flight, which is what it closes.
    const state = await store.getTurnState(sessionId)
    expect(state.state).toBe('running')
    expect(state.openSpan?.seq).toBe(
      raw.find((event) => event.type === EVENT_TYPES.modelRequestStart)?.seq,
    )
  })

  it('lets the next owner close it brain_lost, re-issue the request and finish', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    const handedOff = mockModel({
      text: ['Par', 'tial'],
      onChunk: (_chunk, index) => {
        if (index === 0) {
          controller.abort(new TurnHandoff('shutdown'))
        }
      },
    })
    expect(
      await runTurn(sessionId, {
        store,
        model: handedOff.factory,
        signal: controller.signal,
        resolveCredential: resolveTestCredential,
      }),
    ).toEqual({ outcome: 'handed_off' })
    const openSpan = (await store.getTurnState(sessionId)).openSpan
    expect(openSpan).not.toBeNull()

    // The second call is the partition's next owner: same session, no signal.
    const owner = mockModel({ text: ['Complete'] })
    const outcome = await runTurn(sessionId, {
      store,
      model: owner.factory,
      resolveCredential: resolveTestCredential,
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    // The inherited turn's START closes the open span as lost, superseding the chunks it
    // streamed; then the request it owes is made again and answered once, whole.
    expect(spanErrors(log)).toEqual(['brain_lost', null])
    expect(repliesIn(log)).toEqual(['Complete'])
    expect(eventTypes(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      // The inherited request's start is still in the log; only its chunks are superseded.
      EVENT_TYPES.modelRequestStart,
      // The open span's end. The chunks it superseded are not in the replay read.
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionUsage,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const lost = log.find((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(lost).toMatchObject({ error: { type: 'brain_lost' }, is_error: true })
    expect(lost !== undefined && 'supersedes' in lost ? lost.supersedes : undefined).toBeDefined()
    expect(await store.getTurnState(sessionId)).toEqual({ state: 'idle', openSpan: null })
  })

  it('leaves a tool step unanswered rather than writing an interrupt (mid-tool-step)', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    const { factory } = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'hi' } }] },
      { text: ['After the tool.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      signal: controller.signal,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([abortingTool(controller)]),
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    const raw = await rawLogOf(store, sessionId)
    // The calls are stored — the model really made them — and their answers are not: the next
    // owner writes `execution lost`, never "Interrupted by the user." for a person who did
    // nothing. Nothing ends the turn.
    expect(raw.some((event) => event.type === EVENT_TYPES.agentToolUse)).toBe(true)
    expect(raw.some((event) => event.type === EVENT_TYPES.agentToolResult)).toBe(false)
    expect(raw.some((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toBe(false)
    expect((await store.getTurnState(sessionId)).state).toBe('unfinished')

    // The next owner answers the calls from the crash rule and carries the turn on.
    const owner = mockModel({ text: ['After the tool.'] })
    expect(
      await runTurn(sessionId, {
        store,
        model: owner.factory,
        resolveCredential: resolveTestCredential,
        tools: createToolRegistry([]),
      }),
    ).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    const result = log.find((event) => event.type === EVENT_TYPES.agentToolResult)
    expect(result).toMatchObject({ is_error: true })
    expect(result !== undefined ? JSON.stringify(result.content) : '').toContain('execution lost')
    expect(repliesIn(log)).toEqual(['After the tool.'])
    expect(spanErrors(log)).toEqual([null, null])
    expect(eventTypes(log).at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('writes nothing when the handoff lands between two steps', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const pending = await store.getPendingUserEvents(sessionId)
    const messageId = pending[0]?.id
    expect(messageId).toBeDefined()
    // A first step that ran to completion and called a tool, with the turn left open — the
    // shape a handoff can land on: a span closed, a call stored, no idle.
    await store.appendEvents(sessionId, [statusRunning()])
    const [start] = await store.appendEvents(sessionId, [
      spanStart(messageId === undefined ? [] : [messageId], TEST_MODEL_ID),
    ])
    if (start === undefined) {
      throw new Error('the store did not return the span start it was asked for')
    }
    await store.appendEvents(sessionId, [agentToolUse('echo', { text: 'hi' }, 'allow')])
    await store.appendEvents(sessionId, [spanEnd(start.id, ZERO_MODEL_USAGE, {})])
    const before = (await rawLogOf(store, sessionId)).map((event) => event.id)

    const controller = new AbortController()
    controller.abort(new TurnHandoff('partition_released'))
    const outcome = await runTurn(sessionId, {
      store,
      model: mockModel({ text: ['unused'] }).factory,
      signal: controller.signal,
      resolveCredential: resolveTestCredential,
    })

    expect(outcome).toEqual({ outcome: 'handed_off' })
    // Not one event: the turn is exactly as the previous step left it.
    expect((await rawLogOf(store, sessionId)).map((event) => event.id)).toEqual(before)
    expect((await store.getTurnState(sessionId)).state).toBe('unfinished')
  })

  it('still interrupts exactly as before when the abort has no handoff reason', async () => {
    const { store, sessionId } = await newSession([message('Hello')])
    const controller = new AbortController()
    // Abort as the first delta is stored, which is the moment the existing interrupt tests
    // use: the reply is really streaming, so there is a partial to keep.
    await store.subscribe(sessionId, (event) => {
      if (event.type === EVENT_TYPES.eventDelta) {
        controller.abort()
      }
    })
    const { factory } = mockModel({ text: ['Par', 'tial'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: factory,
      signal: controller.signal,
      resolveCredential: resolveTestCredential,
    })

    // The control: a person's Stop keeps today's ending — the partial reply, the closed span
    // and the idle — which is what makes the handoff a distinct path rather than a rename.
    expect(outcome).toEqual({ outcome: 'interrupted' })
    const raw = await rawLogOf(store, sessionId)
    expect(repliesIn(raw)).toHaveLength(1)
    expect(spanErrors(raw)).toEqual(['interrupted'])
    expect(raw.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })
})

describe('a child that is handed off', () => {
  it('tells its parent nothing until it really ends, which it does once', async () => {
    const { store, sessionId: parentId } = await newSession([message('start a helper')])
    const child = await childOfParent(store, parentId)
    const parentBefore = await logOf(store, parentId)

    const controller = new AbortController()
    const handedOff = mockModel({
      text: ['Par', 'tial'],
      onChunk: (_chunk, index) => {
        if (index === 0) {
          controller.abort(new TurnHandoff('shutdown'))
        }
      },
    })
    expect(
      await runTurn(child.id, {
        store,
        model: handedOff.factory,
        signal: controller.signal,
        resolveCredential: resolveTestCredential,
        subagents: RUNTIME,
      }),
    ).toEqual({ outcome: 'handed_off' })

    // Nothing about an ending reached the parent: no result, no stopped, no idle. (The child's
    // turn start said `running` before the abort, which is the turn opening, not this.)
    const parentAfterHandoff = await logOf(store, parentId)
    const newParentEvents = parentAfterHandoff.slice(parentBefore.length)
    expect(
      newParentEvents.some((event) => event.type === EVENT_TYPES.sessionTaskNotification),
    ).toBe(false)
    expect(
      newParentEvents.some(
        (event) =>
          event.type === EVENT_TYPES.sessionTaskStatus &&
          (event.status === 'stopped' || event.status === 'idle' || event.status === 'failed'),
      ),
    ).toBe(false)
    // The child's turn is open, so its next owner continues it.
    expect((await store.getTurnState(child.id)).state).not.toBe('idle')

    const owner = mockModel({ text: ['The helper is done.'] })
    expect(
      await runTurn(child.id, {
        store,
        model: owner.factory,
        resolveCredential: resolveTestCredential,
        subagents: RUNTIME,
      }),
    ).toEqual({ outcome: 'idle' })

    // Exactly one report, when the child really finished: the result the parent model reads,
    // with the status that moves its card beside it.
    const parent = await logOf(store, parentId)
    const notifications = parent.filter(
      (event) => event.type === EVENT_TYPES.sessionTaskNotification,
    )
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ kind: 'result' })
    expect(JSON.stringify(notifications[0])).toContain('The helper is done.')
    const ended = parent.filter(
      (event) => event.type === EVENT_TYPES.sessionTaskStatus && event.status === 'idle',
    )
    expect(ended).toHaveLength(1)
  })
})
