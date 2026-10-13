import { describe, expect, it } from 'vitest'

import { newEventId, newSessionId, newTaskId } from '@openharness/protocol'
import {
  makeAgentToolUse,
  makeSessionTaskNotification,
  makeSessionTaskStarted,
  makeSessionTaskStatus,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import type { EventId, SessionId, StoredEvent, TaskId } from '@openharness/protocol'

import { isTaskToolName, taskCardStatus, tasksFromEvents } from './tasks'

/**
 * The `agent` call that starts a task, as the parent's log records it (epic #340, S5).
 *
 * `id` is the call's own id — the event's id — which is what a start names in `tool_use_id`.
 */
function agentCall(description: string, type: string, seq: number, id?: EventId): StoredEvent {
  return makeAgentToolUse(
    'agent',
    { type, description, prompt: 'do it' },
    { seq, ...(id === undefined ? {} : { id }) },
  )
}

/**
 * A started task with a type and a description, at a known position.
 *
 * `toolUseId` is the call that started it (#345): omitted it is a start from a log stored before
 * the field existed, which the fold matches by description.
 */
function started(
  taskId: TaskId,
  childSessionId: SessionId,
  description: string,
  seq: number,
  type = 'researcher',
  toolUseId?: EventId,
): StoredEvent {
  return makeSessionTaskStarted({
    seq,
    task_id: taskId,
    child_session_id: childSessionId,
    task_type: type,
    description,
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
  })
}

/** A message the parent sent its child — the call's `text` becomes a `user.message` there. */
function toldChild(taskId: TaskId, text: string, seq: number): StoredEvent {
  return makeAgentToolUse('agent_message', { task_id: taskId, text }, { seq })
}

/** Something the child said back, which is a `message` notification. */
function childSaid(taskId: TaskId, text: string, seq: number): StoredEvent {
  return makeSessionTaskNotification(taskId, {
    seq,
    kind: 'message',
    text,
    source_key: `${taskId}:${seq}`,
  })
}

/** A finished turn's outcome — the newest of these is a card's result. */
function outcome(
  taskId: TaskId,
  kind: 'result' | 'failed',
  text: string,
  seq: number,
): StoredEvent {
  return makeSessionTaskNotification(taskId, { seq, kind, text, source_key: `${taskId}:${seq}` })
}

describe('tasksFromEvents (#340, S4; #345)', () => {
  const taskId = newTaskId()
  const child = newSessionId()
  const description = 'Research how the event log handles a rewind'

  /** The events that open the task, for the cases that are about what comes after. */
  const opened: readonly StoredEvent[] = [
    agentCall(description, 'researcher', 2),
    started(taskId, child, description, 3),
  ]

  it('opens a card at the agent call that started the task', () => {
    const log = [
      makeUserMessage('look into rewinds', { seq: 1, processed_at: null }),
      ...opened,
      makeSessionTaskStatus(taskId, 'running', { seq: 4 }),
    ]

    expect(tasksFromEvents(log)).toEqual([
      {
        id: taskId,
        kind: 'subagent',
        childSessionId: child,
        type: 'researcher',
        description,
        status: 'running',
        messages: [],
        result: null,
        position: 2,
      },
    ])
  })

  it('falls back to the start event’s own position when the call is not in the log', () => {
    expect(tasksFromEvents([started(taskId, child, description, 7)])[0]?.position).toBe(7)
  })

  it('matches a start to the call with its own description, not merely the last one', () => {
    // The first call was refused — the live-task limit — so no start names it; the task's own
    // call is the second, and the card sits there rather than at the call that came before.
    const log = [
      agentCall('a task nobody started', 'general-purpose', 2),
      agentCall(description, 'researcher', 5),
      started(taskId, child, description, 6),
    ]

    expect(tasksFromEvents(log)[0]?.position).toBe(5)
  })

  it('places each card at the call its tool_use_id names, even when two calls share a description', () => {
    // One step made two calls with the same words, and both starts arrive after both calls. The
    // description join alone would answer the newest unmatched call for the first start and the
    // older one for the second — the cards swapped. The log's own link does not: each start
    // names the call it came from, so each card sits where its call is.
    const first = newEventId()
    const second = newEventId()
    const other = newTaskId()
    const log = [
      agentCall(description, 'researcher', 2, first),
      agentCall(description, 'researcher', 3, second),
      started(other, newSessionId(), description, 6, 'researcher', second),
      started(taskId, child, description, 7, 'researcher', first),
    ]

    expect(tasksFromEvents(log).map((card) => [card.id, card.position])).toEqual([
      [taskId, 2],
      [other, 3],
    ])
  })

  it('falls back to the start’s own position when the call its tool_use_id names is gone', () => {
    // A trimmed replay: the link is in the event, the call is not in the events handed over, so
    // the card takes the start's own position rather than another call's.
    expect(
      tasksFromEvents([started(taskId, child, description, 9, 'researcher', newEventId())])[0]
        ?.position,
    ).toBe(9)
  })

  it('is done once an idle task has delivered its result', () => {
    const log = [
      ...opened,
      makeSessionTaskStatus(taskId, 'idle', { seq: 9 }),
      outcome(taskId, 'result', 'The rewind drops the branch.', 10),
    ]

    expect(tasksFromEvents(log)[0]).toMatchObject({
      status: 'done',
      result: { kind: 'result', text: 'The rewind drops the branch.', seq: 10 },
    })
  })

  it('is failed when the task ended in an error', () => {
    const log = [
      ...opened,
      makeSessionTaskStatus(taskId, 'failed', { seq: 9 }),
      outcome(taskId, 'failed', 'the child hit its step limit', 10),
    ]

    expect(tasksFromEvents(log)[0]).toMatchObject({
      status: 'failed',
      result: { kind: 'failed', text: 'the child hit its step limit', seq: 10 },
    })
  })

  it('is stopped when it was stopped, result or not', () => {
    const log = [...opened, makeSessionTaskStatus(taskId, 'stopped', { seq: 6 })]

    expect(tasksFromEvents(log)[0]?.status).toBe('stopped')

    // The shape a reader's Stop leaves (S7; #348): a `stopped` status **and** the `result` the
    // brain delivers for the stopped turn. `done` is `idle` + a result alone — a stopped task has
    // an answer `idle` cannot give, so the result never makes it read as finished.
    const withNews = [...log, outcome(taskId, 'result', 'The user stopped this subagent.', 7)]

    expect(tasksFromEvents(withNews)[0]).toMatchObject({
      status: 'stopped',
      result: { kind: 'result', text: 'The user stopped this subagent.' },
    })
  })

  it('keeps an idle task that has told the parent nothing as running', () => {
    // Not every turn ends with a result: one that ended before delivering anything is not a
    // completion, and "done" would be a claim the log does not make.
    const log = [...opened, makeSessionTaskStatus(taskId, 'idle', { seq: 9 })]

    expect(tasksFromEvents(log)[0]?.status).toBe('running')
  })

  it('keeps every message in order, and the newest outcome as the result', () => {
    const log = [
      ...opened,
      toldChild(taskId, 'start with the rewind', 5),
      childSaid(taskId, 'which rewind — the client’s or the store’s?', 6),
      toldChild(taskId, 'the client’s', 7),
      outcome(taskId, 'result', 'The client drops the range.', 8),
      toldChild(taskId, 'now the continuation', 11),
      outcome(taskId, 'result', 'The continuation is a second turn.', 12),
    ]

    const [card] = tasksFromEvents(log)

    expect(card?.messages).toEqual([
      { from: 'parent', text: 'start with the rewind', seq: 5 },
      { from: 'child', text: 'which rewind — the client’s or the store’s?', seq: 6 },
      { from: 'parent', text: 'the client’s', seq: 7 },
      { from: 'parent', text: 'now the continuation', seq: 11 },
    ])
    expect(card?.result).toEqual({
      kind: 'result',
      text: 'The continuation is a second turn.',
      seq: 12,
    })
  })

  it('continues a child that already reported into a running task with a second result', () => {
    const log = [
      ...opened,
      makeSessionTaskStatus(taskId, 'idle', { seq: 9 }),
      outcome(taskId, 'result', 'first', 10),
      toldChild(taskId, 'one more thing', 13),
      makeSessionTaskStatus(taskId, 'running', { seq: 14 }),
      makeSessionTaskStatus(taskId, 'idle', { seq: 20 }),
      outcome(taskId, 'result', 'second', 21),
    ]

    const [card] = tasksFromEvents(log)

    expect(card?.status).toBe('done')
    expect(card?.result?.text).toBe('second')
  })

  it('orders the cards by where their calls are', () => {
    const other = newTaskId()
    const log = [
      agentCall(description, 'researcher', 2),
      started(taskId, child, description, 3),
      agentCall('the second task', 'general-purpose', 8),
      started(other, newSessionId(), 'the second task', 9, 'general-purpose'),
    ]

    expect(tasksFromEvents(log).map((card) => card.id)).toEqual([taskId, other])
    expect(tasksFromEvents(log).map((card) => [card.type, card.position])).toEqual([
      ['researcher', 2],
      ['general-purpose', 8],
    ])
  })

  it('carries no child session for a task that has none', () => {
    // A kind that is not a session of its own — a subprocess, a scheduled job — carries no
    // child, and a card offers Open only when there is one to open.
    const log = [
      makeSessionTaskStarted({
        seq: 3,
        task_id: taskId,
        description,
        child_session_id: undefined,
      }),
    ]

    expect(tasksFromEvents(log)[0]).toMatchObject({ childSessionId: null, position: 3 })
  })

  it('ignores a notification for a task the events do not start', () => {
    expect(tasksFromEvents([outcome(taskId, 'result', 'orphaned', 4)])).toEqual([])
  })

  it('ignores a log with nothing about tasks', () => {
    expect(tasksFromEvents([makeUserMessage('hello', { seq: 1, processed_at: null })])).toEqual([])
  })
})

describe('taskCardStatus (#340, S9; #345)', () => {
  it('is waiting when the child’s own log says it is', () => {
    expect(taskCardStatus('running', true)).toBe('waiting')
  })

  it('leaves a task that already has an answer alone', () => {
    expect(taskCardStatus('done', true)).toBe('done')
    expect(taskCardStatus('failed', true)).toBe('failed')
    expect(taskCardStatus('stopped', true)).toBe('stopped')
  })

  it('is the parent’s own status when the child is not waiting', () => {
    expect(taskCardStatus('running', false)).toBe('running')
  })
})

describe('isTaskToolName (#340, S9; #345)', () => {
  it('knows the four the card stands in for', () => {
    expect(['agent', 'agent_message', 'agent_wait', 'agent_stop'].every(isTaskToolName)).toBe(true)
  })

  it('leaves an ordinary tool — and a remote one — as a tool line', () => {
    expect(isTaskToolName('web_fetch')).toBe(false)
    expect(isTaskToolName('notes__agent')).toBe(false)
    expect(isTaskToolName('todo_write')).toBe(false)
  })
})
