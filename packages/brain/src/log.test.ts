import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type { StoredEvent } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { contextView, lastStatusEventType, needsModelRequest, readLog } from './log'
import { newSession } from './testing/harness'

/** A message event, queued or claimed. */
function message(seq: number, processed: boolean): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.userMessage,
    seq,
    processed_at: processed ? '2026-03-15T10:00:00.000Z' : null,
    content: [{ type: 'text', text: `message ${seq}` }],
  }
}

/** A reply, as the log stores one. */
function reply(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.agentMessage,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text: `reply ${seq}` }],
  }
}

/** A span start, as the log stores one. */
function spanStart(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.modelRequestStart,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
  }
}

/** A status event. */
function status(seq: number, type: string): StoredEvent {
  return {
    id: newEventId(),
    type,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
  } as StoredEvent
}

describe('readLog', () => {
  it('pages through a log longer than one page', async () => {
    const { store, sessionId } = await newSession()
    const appended = await store.appendEvents(
      sessionId,
      Array.from({ length: 250 }, () => ({
        type: EVENT_TYPES.sessionStatusRunning,
      })),
    )

    const log = await readLog(store, sessionId)

    expect(log).toHaveLength(250)
    expect(log.map((event) => event.seq)).toEqual(appended.map((event) => event.seq))
  })

  it('reads an empty log', async () => {
    const { store, sessionId } = await newSession()

    expect(await readLog(store, sessionId)).toEqual([])
  })
})

describe('lastStatusEventType', () => {
  it('answers the last status event, whatever else the log holds', () => {
    expect(lastStatusEventType([])).toBeUndefined()
    expect(
      lastStatusEventType([
        status(1, EVENT_TYPES.sessionStatusRunning),
        message(2, true),
        status(3, EVENT_TYPES.sessionStatusRescheduled),
        message(4, true),
      ]),
    ).toBe(EVENT_TYPES.sessionStatusRescheduled)
    expect(lastStatusEventType([status(1, EVENT_TYPES.sessionStatusIdle)])).toBe(
      EVENT_TYPES.sessionStatusIdle,
    )
  })
})

describe('contextView', () => {
  it('leaves out the user events that are still waiting to be claimed', () => {
    const queued = message(1, false)
    const claimed = message(2, true)
    const interrupt: StoredEvent = {
      id: newEventId(),
      type: EVENT_TYPES.userInterrupt,
      seq: 3,
      processed_at: null,
    }

    const answered = reply(4)

    expect(contextView([queued, claimed, interrupt, answered])).toEqual([claimed, answered])
  })
})

describe('needsModelRequest', () => {
  it('is true while a claimed message has no reply', () => {
    expect(needsModelRequest([message(1, true)])).toBe(true)
    expect(needsModelRequest([message(1, true), status(2, EVENT_TYPES.sessionStatusRunning)])).toBe(
      true,
    )
  })

  it('is false once every claimed message has been answered', () => {
    expect(
      needsModelRequest([
        message(1, true),
        status(2, EVENT_TYPES.sessionStatusRunning),
        spanStart(3),
        reply(4),
      ]),
    ).toBe(false)
  })

  it('counts a message that arrived mid-request as unanswered', () => {
    // The shape a steer leaves in the log: the message lands while the first request streams,
    // so the reply that follows it belongs to the request before it.
    const events = [
      message(1, true),
      status(2, EVENT_TYPES.sessionStatusRunning),
      spanStart(3),
      message(4, true),
      reply(5),
    ]

    expect(needsModelRequest(events)).toBe(true)
  })

  it('has nothing to answer when the only message is still queued', () => {
    // Which is why the loop builds its view first: an unclaimed message is the next turn's.
    expect(needsModelRequest(contextView([message(1, false)]))).toBe(false)
  })
})
