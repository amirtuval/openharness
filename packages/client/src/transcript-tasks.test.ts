import { describe, expect, it } from 'vitest'

import { newSessionId, newTaskId } from '@openharness/protocol'
import {
  makeAgentToolUse,
  makeSessionRewind,
  makeSessionTaskNotification,
  makeSessionTaskStarted,
  makeSessionTaskStatus,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import type { StreamEvent } from '@openharness/protocol'

import {
  initialTranscriptState,
  reduceTranscriptAll,
  selectTasks,
  selectToolCalls,
  selectTranscriptEntries,
} from './transcript'

/** Fold a sequence of events into a fresh transcript. */
function reduce(events: readonly StreamEvent[]) {
  return reduceTranscriptAll(initialTranscriptState(), events)
}

const taskId = newTaskId()
const child = newSessionId()
const description = 'Research how the event log handles a rewind'

/** The `agent` call the card stands in for. */
const call = makeAgentToolUse(
  'agent',
  { type: 'researcher', description, prompt: 'do it' },
  { seq: 2 },
)

/** The task's start, right behind the call, as the tool that writes it produces it. */
const start = makeSessionTaskStarted({
  seq: 3,
  task_id: taskId,
  child_session_id: child,
  task_type: 'researcher',
  description,
})

describe('background tasks in the transcript (#340, S9; #345)', () => {
  it('does not draw the task machinery’s calls as tool lines', () => {
    const log = [
      makeUserMessage('look into rewinds', { seq: 1, processed_at: null }),
      call,
      start,
      makeAgentToolUse(
        'agent_message',
        { task_id: taskId, text: 'start with the rewind' },
        { seq: 5 },
      ),
      makeAgentToolUse('agent_wait', { task_ids: [taskId] }, { seq: 6 }),
      makeAgentToolUse('agent_stop', { task_id: taskId }, { seq: 7 }),
    ]

    const state = reduce(log)

    expect(selectToolCalls(state)).toEqual([])
    // The conversation is the reader's own message and nothing else: the card is not an entry,
    // it is state, and the calls it stands in for are gone from the entries.
    expect(selectTranscriptEntries(state).map((entry) => entry.kind)).toEqual(['message'])
  })

  it('puts the card at the agent call it replaced, in card order', () => {
    const state = reduce([
      makeUserMessage('go', { seq: 1, processed_at: null }),
      call,
      start,
      makeSessionTaskStatus(taskId, 'running', { seq: 4 }),
    ])

    expect(selectTasks(state)).toEqual([
      {
        id: taskId,
        kind: 'subagent',
        childSessionId: child,
        type: 'researcher',
        description,
        status: 'running',
        messages: [],
        result: null,
        position: call.seq,
      },
    ])
  })

  it('carries the conversation and the result the log holds', () => {
    const state = reduce([
      call,
      start,
      makeAgentToolUse(
        'agent_message',
        { task_id: taskId, text: 'start with the rewind' },
        { seq: 5 },
      ),
      makeSessionTaskNotification(taskId, {
        seq: 6,
        kind: 'message',
        text: 'which rewind?',
        source_key: `${taskId}:6`,
      }),
      makeSessionTaskStatus(taskId, 'idle', { seq: 7 }),
      makeSessionTaskNotification(taskId, {
        seq: 8,
        kind: 'result',
        text: 'The client drops the range.',
        source_key: `${taskId}:8`,
      }),
    ])

    expect(selectTasks(state)[0]).toMatchObject({
      status: 'done',
      messages: [
        { from: 'parent', text: 'start with the rewind', seq: 5 },
        { from: 'child', text: 'which rewind?', seq: 6 },
      ],
      result: { kind: 'result', text: 'The client drops the range.', seq: 8 },
    })
  })

  it('moves the card through every status the parent’s log records', () => {
    const status = (value: 'running' | 'idle' | 'failed' | 'stopped', seq: number) =>
      makeSessionTaskStatus(taskId, value, { seq })

    expect(selectTasks(reduce([call, start]))[0]?.status).toBe('running')
    expect(
      selectTasks(
        reduce([
          call,
          start,
          status('idle', 4),
          makeSessionTaskNotification(taskId, {
            seq: 5,
            kind: 'result',
            text: 'done',
            source_key: 'k',
          }),
        ]),
      )[0]?.status,
    ).toBe('done')
    expect(selectTasks(reduce([call, start, status('failed', 4)]))[0]?.status).toBe('failed')
    expect(selectTasks(reduce([call, start, status('stopped', 4)]))[0]?.status).toBe('stopped')
  })

  it('drops a card a rewind took back', () => {
    // Rewinding past the `agent` call stops that child (epic #340, S7): the start, its
    // statuses and its notifications are all inside the range the edit replaced.
    const log: readonly StreamEvent[] = [
      makeUserMessage('look into rewinds', { seq: 1, processed_at: null }),
      call,
      start,
      makeSessionTaskStatus(taskId, 'running', { seq: 4 }),
      makeSessionRewind({ seq: 5, supersedes: { from_seq: 1, to_seq: 4 } }),
    ]

    expect(selectTasks(reduce(log))).toEqual([])
  })

  it('keeps a card the rewind did not reach', () => {
    const log: readonly StreamEvent[] = [
      makeUserMessage('first', { seq: 1, processed_at: null }),
      makeUserMessage('second', { seq: 2, processed_at: null }),
      call,
      start,
      makeSessionRewind({ seq: 5, supersedes: { from_seq: 1, to_seq: 1 } }),
    ]

    expect(selectTasks(reduce(log)).map((card) => card.id)).toEqual([taskId])
  })

  it('starts a session with no tasks', () => {
    expect(selectTasks(initialTranscriptState())).toEqual([])
  })
})
