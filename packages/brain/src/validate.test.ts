import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type { EventId, ModelUsage } from '@openharness/protocol'
import type { AppendableEvent } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import {
  agentMessage,
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
        spanStart(),
        spanEnd(newEventId(), ZERO_MODEL_USAGE),
        spanEnd(newEventId(), ZERO_MODEL_USAGE, { type: 'interrupted', message: 'Interrupted.' }),
        agentMessage(newEventId(), 'Hello'),
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
    const preview = { type: EVENT_TYPES.eventDelta } as unknown as AppendableEvent

    expect(() => {
      assertValidEvents([preview])
    }).toThrow(EventValidationError)
  })
})
