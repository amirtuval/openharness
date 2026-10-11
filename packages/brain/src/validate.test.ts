import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type { EventId, ModelUsage } from '@openharness/protocol'
import type { AppendableEvent } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import {
  agentMessage,
  eventDelta,
  eventStart,
  sessionError,
  spanEnd,
  spanStart,
  statusIdle,
  statusRescheduled,
  statusRunning,
} from './events'
import { ZERO_MODEL_USAGE } from './model'
import { assertValidEvents, EventValidationError } from './validate'

/**
 * The protocol check between the brain and the store.
 *
 * The point of the check is that a malformed event never becomes a stored one, however it was
 * built, so the tests are the two halves of that: everything the loop writes passes, and
 * anything that does not describe a protocol event is refused *here*, before the append.
 */

describe('assertValidEvents', () => {
  it('accepts every event the turn loop builds', () => {
    const messageId = newEventId()
    const range = { from_seq: 4, to_seq: 6 }

    expect(() => {
      assertValidEvents([
        statusRunning(),
        statusIdle(),
        statusRescheduled(),
        sessionError({
          type: 'model_rate_limited_error',
          message: 'Rate limited.',
          retry_status: { type: 'retrying' },
        }),
        spanStart([newEventId()], 'anthropic/claude-sonnet-5'),
        spanStart([], 'anthropic/claude-sonnet-5'),
        spanEnd(newEventId(), ZERO_MODEL_USAGE),
        spanEnd(newEventId(), ZERO_MODEL_USAGE, {
          error: { type: 'interrupted', message: 'Interrupted.' },
          consumes: [newEventId()],
        }),
        spanEnd(newEventId(), ZERO_MODEL_USAGE, {
          error: { type: 'model_error' },
          supersedes: range,
        }),
        spanEnd(newEventId(), ZERO_MODEL_USAGE, {
          error: { type: 'brain_lost' },
          supersedes: range,
        }),
        statusIdle({ consumes: [newEventId()] }),
        eventStart(messageId),
        eventDelta(messageId, 'Hel'),
        agentMessage(messageId, 'Hello', range),
      ])
    }).not.toThrow()
  })

  it('rejects a claim that names something that is not an event id', () => {
    expect(() => {
      assertValidEvents([spanStart(['not-an-id' as EventId], 'anthropic/claude-sonnet-5')])
    }).toThrow(/span\.model_request_start.*consumes/m)
  })

  it('rejects a supersedes range that is not a pair of seqs', () => {
    expect(() => {
      assertValidEvents([agentMessage(newEventId(), 'Hello', { from_seq: 0, to_seq: 3 })])
    }).toThrow(/agent\.message.*supersedes/m)
  })

  it('rejects a chunk delta that carries no text', () => {
    // Not a block the protocol accepts: `TextBlockSchema` wants at least one character, and a
    // frame a validating reader would stop at must never be stored.
    expect(() => {
      assertValidEvents([eventDelta(newEventId(), '')])
    }).toThrow(/event_delta.*text/m)
  })

  it('accepts a queued user event, which is stored before it is processed', () => {
    // The brain writes no user events, so this is the check on the check: a type whose stored
    // `processed_at` is `null` must not be refused for a timestamp it never has.
    expect(() => {
      assertValidEvents([
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'Hello' }] },
      ])
    }).not.toThrow()
  })

  it('rejects a usage that is not the protocol counters', () => {
    // The shape a real provider's turn used to store: the counters as the string `ai` left
    // behind. The protocol asks for integers, and the log must not get anything else.
    const corrupted = {
      input_tokens: '0[object Object]',
      output_tokens: '0[object Object]',
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as unknown as ModelUsage

    expect(() => {
      assertValidEvents([spanEnd(newEventId(), corrupted)])
    }).toThrow(EventValidationError)
  })

  it('names the event and the field that was wrong', () => {
    const corrupted = { ...ZERO_MODEL_USAGE, input_tokens: -1 }

    expect(() => {
      assertValidEvents([spanEnd(newEventId(), corrupted)])
    }).toThrow(/span\.model_request_end.*model_usage\.input_tokens/m)
  })

  it('rejects an id that is not an event id', () => {
    expect(() => {
      assertValidEvents([agentMessage('not-an-event-id' as EventId, 'Hello')])
    }).toThrow(EventValidationError)
  })

  it('rejects an event type the log does not hold', () => {
    const unknown = { type: 'agent.thinking', text: 'why' } as unknown as AppendableEvent

    expect(() => {
      assertValidEvents([unknown])
    }).toThrow(EventValidationError)
  })

  it('still rejects a chunk that is missing the fields of its shape', () => {
    // A stream-only preview has no envelope, but the brain appends chunks as stored events: an
    // `event_delta` without its `delta` is not an event any reader could use, envelope or not.
    const halfABlock = { type: EVENT_TYPES.eventDelta } as unknown as AppendableEvent

    expect(() => {
      assertValidEvents([halfABlock])
    }).toThrow(EventValidationError)
  })
})
