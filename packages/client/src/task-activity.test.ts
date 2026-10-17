import { describe, expect, it, vi } from 'vitest'

import { newTaskId } from '@openharness/protocol'
import {
  makeAgentMessage,
  makeAgentToolResult,
  makeAgentToolUse,
  makeModelEntry,
  makeSessionUsage,
  makeStatusIdle,
  makeStatusRunning,
} from '@openharness/protocol/fixtures'
import type { ModelCost, StoredEvent, StreamEvent } from '@openharness/protocol'

import { sleep } from './internal/async'
import { initialTranscriptState, reduceTranscriptAll } from './transcript'
import type { ModelPriceLookup } from './transcript'
import { taskActivityLabel, taskActivityOf, watchTaskActivity } from './task-activity'
import type { TaskActivityLog } from './task-activity'

/** Fold events into a transcript — the child's own state, as the watcher keeps it. */
function childState(events: readonly StreamEvent[]) {
  return reduceTranscriptAll(initialTranscriptState(), events)
}

/** The catalog's price of one model, for the cost half of the snapshot. */
const prices: ModelPriceLookup = (modelId): ModelCost | null =>
  modelId === 'anthropic/claude-sonnet-5' ? makeModelEntry().cost : null

describe('taskActivityOf (#340, S9; #345)', () => {
  it('names the tool call the child has out', () => {
    const state = childState([
      makeStatusRunning({ seq: 1 }),
      makeAgentToolUse('web_fetch', { url: 'https://example.com' }, { seq: 2 }),
    ])

    expect(taskActivityOf(state).activity).toEqual({
      kind: 'tool',
      name: 'web_fetch',
      summary: 'https://example.com',
    })
  })

  it('falls back to the task list when no call is out', () => {
    // Two of the three items done — the "2 of 3" a card draws.
    const call = makeAgentToolUse(
      'todo_write',
      {
        todos: [
          { content: 'read the log', status: 'done' },
          { content: 'write the reducer', status: 'done' },
          { content: 'write the test', status: 'in_progress' },
        ],
      },
      { seq: 2 },
    )
    const state = childState([
      makeStatusRunning({ seq: 1 }),
      call,
      makeAgentToolResult(call, 'Noted.', { seq: 3 }),
    ])

    expect(taskActivityOf(state).activity).toEqual({ kind: 'todos', done: 2, total: 3 })
  })

  it('is writing while the child’s turn runs and nothing else is happening', () => {
    const state = childState([makeStatusRunning({ seq: 1 })])

    expect(taskActivityOf(state).activity).toEqual({ kind: 'writing' })
  })

  it('is idle when the child has stopped', () => {
    const state = childState([makeAgentMessage('done', { seq: 1 }), makeStatusIdle({ seq: 2 })])

    expect(taskActivityOf(state).activity).toEqual({ kind: 'idle' })
  })

  it('reports the child’s own tokens and what they cost', () => {
    const state = childState([
      makeAgentMessage('the answer', { seq: 1 }),
      makeStatusIdle({ seq: 2 }),
      makeSessionUsage(undefined, { seq: 3 }),
    ])

    const activity = taskActivityOf(state, { prices })

    expect(activity.usage).toEqual({ input: 512, output: 64, cacheCreation: 0, cacheRead: 0 })
    // 512 × $2/M + 64 × $10/M — the rates the fixture entry carries, priced the one way.
    expect(activity.cost?.cost).toBeCloseTo(0.001664, 10)
    expect(activity.cost?.unpriced_requests).toBe(0)
    expect(activity.model).toBeNull()
  })

  it('reports no cost at all for a caller with no catalog', () => {
    const state = childState([makeSessionUsage(undefined, { seq: 1 })])

    expect(taskActivityOf(state).cost).toBeNull()
  })

  it('says there are no tokens until the child’s log reports some', () => {
    expect(taskActivityOf(childState([])).usage).toBeNull()
  })

  it('carries the waiting flag through to the snapshot', () => {
    expect(taskActivityOf(childState([]), { waiting: true }).waiting).toBe(true)
    expect(taskActivityOf(childState([])).waiting).toBe(false)
  })
})

describe('taskActivityLabel (#340, S9; #345)', () => {
  it('draws a tool as its name and its summary', () => {
    expect(taskActivityLabel({ kind: 'tool', name: 'web_fetch', summary: 'https://a.test' })).toBe(
      'web_fetch: https://a.test',
    )
    expect(taskActivityLabel({ kind: 'tool', name: 'web_fetch', summary: null })).toBe('web_fetch')
  })

  it('draws a task list as the count the todo panel draws', () => {
    expect(taskActivityLabel({ kind: 'todos', done: 2, total: 5 })).toBe('2 of 5')
  })

  it('draws a model that is writing as writing…', () => {
    expect(taskActivityLabel({ kind: 'writing' })).toBe('writing…')
  })

  it('draws nothing for a child that is doing nothing', () => {
    expect(taskActivityLabel({ kind: 'idle' })).toBeNull()
  })
})

/** A read that throws when it is iterated, standing in for a session nothing can read. */
function failing(message: string): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => Promise.reject(new Error(message)) }
    },
  }
}

/** A `client.sessions.events` double: scripted history, then a scripted live stream. */
function scripted(history: readonly StoredEvent[], live: readonly StreamEvent[]) {
  const streams: { signal?: AbortSignal }[] = []
  let iterates = 0
  const log: TaskActivityLog = {
    async *iterate() {
      iterates += 1
      await sleep(0)
      for (const event of history) {
        yield event
      }
    },
    async *stream(_sessionId, options) {
      const signal = options?.signal
      streams.push(signal === undefined ? {} : { signal })
      for (const event of live) {
        if (signal?.aborted === true) {
          return
        }
        yield event
      }
      // A real stream never ends on its own; it stays open until the caller aborts.
      while (signal?.aborted !== true) {
        await sleep(1)
      }
    },
  }
  return {
    log,
    streams,
    iterateCount: () => iterates,
  }
}

describe('watchTaskActivity (#340, S9; #345)', () => {
  it('follows nothing until something watches', () => {
    const scriptedLog = scripted([], [])

    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child')

    expect(activity.getState().activity).toEqual({ kind: 'idle' })
    expect(scriptedLog.iterateCount()).toBe(0)
    expect(scriptedLog.streams).toHaveLength(0)
  })

  it('reads the child’s history and then follows it live', async () => {
    const scriptedLog = scripted(
      [makeStatusRunning({ seq: 1 })],
      [makeAgentToolUse('web_fetch', { url: 'https://example.com' }, { seq: 2 })],
    )
    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child', { prices })

    const seen: string[] = []
    const off = activity.subscribe((state) => seen.push(state.activity.kind))

    await vi.waitFor(() => {
      expect(activity.getState().activity).toEqual({
        kind: 'tool',
        name: 'web_fetch',
        summary: 'https://example.com',
      })
    })
    expect(scriptedLog.iterateCount()).toBe(1)
    expect(scriptedLog.streams).toHaveLength(1)
    // Every change reaches a listener, in order: the turn starting, then the call it made.
    expect(seen).toEqual(['writing', 'tool'])

    off()
  })

  it('unsubscribes the child’s stream when nothing watches it', async () => {
    const scriptedLog = scripted([], [makeStatusRunning({ seq: 1 })])
    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child')

    const off = activity.subscribe(() => {})
    await vi.waitFor(() => {
      expect(scriptedLog.streams).toHaveLength(1)
    })
    const signal = scriptedLog.streams[0]?.signal
    expect(signal?.aborted).toBe(false)

    off()

    expect(signal?.aborted).toBe(true)
  })

  it('keeps the stream open while one of two watchers is left', async () => {
    const scriptedLog = scripted([], [makeStatusRunning({ seq: 1 })])
    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child')

    const offFirst = activity.subscribe(() => {})
    const offSecond = activity.subscribe(() => {})
    await vi.waitFor(() => {
      expect(scriptedLog.streams).toHaveLength(1)
    })
    const signal = scriptedLog.streams[0]?.signal

    offFirst()
    expect(signal?.aborted).toBe(false)
    expect(scriptedLog.streams).toHaveLength(1)

    offSecond()
    expect(signal?.aborted).toBe(true)
  })

  it('stops following when it is closed', async () => {
    const scriptedLog = scripted([], [makeStatusRunning({ seq: 1 })])
    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child')

    activity.subscribe(() => {})
    await vi.waitFor(() => {
      expect(scriptedLog.streams).toHaveLength(1)
    })
    const signal = scriptedLog.streams[0]?.signal

    activity.close()

    expect(signal?.aborted).toBe(true)
  })

  it('is waiting while the child’s own turn ended waiting on tasks', async () => {
    const scriptedLog = scripted(
      [
        makeStatusIdle({
          seq: 1,
          stop_reason: {
            type: 'waiting_on_tasks',
            task_ids: [newTaskId()],
            deadline: '2026-03-15T10:10:00Z',
          },
        }),
      ],
      [],
    )
    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child')

    activity.subscribe(() => {})

    await vi.waitFor(() => {
      expect(activity.getState().waiting).toBe(true)
    })
    expect(activity.getState().status).toBe('idle')
  })

  it('stops waiting when the child runs again', async () => {
    const scriptedLog = scripted(
      [
        makeStatusIdle({
          seq: 1,
          stop_reason: {
            type: 'waiting_on_tasks',
            task_ids: [newTaskId()],
            deadline: '2026-03-15T10:10:00Z',
          },
        }),
      ],
      [makeStatusRunning({ seq: 2 })],
    )
    const activity = watchTaskActivity(scriptedLog.log, 'sesn_child')

    const off = activity.subscribe(() => {})
    await vi.waitFor(() => {
      expect(activity.getState().status).toBe('running')
    })

    expect(activity.getState().waiting).toBe(false)
    off()
  })

  it('reports a child it cannot read, and keeps working', async () => {
    const onDebug = vi.fn()
    const log: TaskActivityLog = {
      iterate: () => failing('not found'),
      stream: () => failing('unreachable'),
    }
    const activity = watchTaskActivity(log, 'sesn_missing', { onDebug })

    activity.subscribe(() => {})

    await vi.waitFor(() => {
      expect(onDebug).toHaveBeenCalledTimes(1)
    })
    expect(activity.getState().activity).toEqual({ kind: 'idle' })
  })
})
