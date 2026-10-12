import { describe, expect, it } from 'vitest'

import { newEventId } from '../ids'
import { EVENT_TYPES, STORED_EVENT_TYPES } from './common'
import {
  UserToolConfirmationEventInputSchema,
  UserToolConfirmationEventSchema,
} from './tool-confirmation'
import { StoredEventSchema } from './union'

/** A stored confirmation, as a server writes one. */
const stored = {
  id: newEventId(),
  type: EVENT_TYPES.userToolConfirmation,
  seq: 4,
  processed_at: '2026-03-15T10:00:00Z',
  tool_use_id: newEventId(),
  result: 'allow',
} as const

describe('the stored user.tool_confirmation', () => {
  it('is a stored event type and parses as one', () => {
    expect(STORED_EVENT_TYPES).toContain(EVENT_TYPES.userToolConfirmation)
    expect(StoredEventSchema.safeParse(stored).success).toBe(true)
    expect(UserToolConfirmationEventSchema.safeParse(stored).success).toBe(true)
  })

  it('is never queued: `processed_at` is a timestamp, not null', () => {
    expect(StoredEventSchema.safeParse({ ...stored, processed_at: null }).success).toBe(false)
    const { processed_at: _processedAt, ...withoutTimestamp } = stored
    expect(StoredEventSchema.safeParse(withoutTimestamp).success).toBe(false)
  })

  it('carries the two extensions, and refuses them where they mean nothing', () => {
    expect(
      UserToolConfirmationEventSchema.safeParse({ ...stored, remember: 'session' }).success,
    ).toBe(true)
    expect(
      UserToolConfirmationEventSchema.safeParse({
        ...stored,
        answers: [{ question: 'Which?', labels: ['one'] }],
      }).success,
    ).toBe(true)
    expect(
      UserToolConfirmationEventSchema.safeParse({ ...stored, result: 'deny', remember: 'always' })
        .success,
    ).toBe(false)
    expect(
      UserToolConfirmationEventSchema.safeParse({
        ...stored,
        result: 'deny',
        answers: [{ question: 'Which?', text: 'one' }],
      }).success,
    ).toBe(false)
    expect(
      UserToolConfirmationEventSchema.safeParse({ ...stored, deny_message: 'not now' }).success,
    ).toBe(false)
    expect(
      UserToolConfirmationEventSchema.safeParse({
        ...stored,
        result: 'deny',
        deny_message: 'not now',
      }).success,
    ).toBe(true)
  })
})

describe('the client-sent user.tool_confirmation', () => {
  it('is the same shape without the fields the server assigns', () => {
    const { id: _id, seq: _seq, processed_at: _processedAt, ...input } = stored
    expect(UserToolConfirmationEventInputSchema.safeParse(input).success).toBe(true)
    expect(UserToolConfirmationEventInputSchema.safeParse(stored).success).toBe(true)
  })

  it('insists on a known result and a `tool_use_id` of the right shape', () => {
    expect(
      UserToolConfirmationEventInputSchema.safeParse({
        type: EVENT_TYPES.userToolConfirmation,
        tool_use_id: stored.tool_use_id,
        result: 'maybe',
      }).success,
    ).toBe(false)
    expect(
      UserToolConfirmationEventInputSchema.safeParse({
        type: EVENT_TYPES.userToolConfirmation,
        tool_use_id: 'not-an-event-id',
        result: 'allow',
      }).success,
    ).toBe(false)
  })

  it('refuses a denial that remembers, and an approval carrying excuses', () => {
    const body = { type: EVENT_TYPES.userToolConfirmation, tool_use_id: stored.tool_use_id }
    expect(
      UserToolConfirmationEventInputSchema.safeParse({
        ...body,
        result: 'deny',
        remember: 'once',
      }).success,
    ).toBe(false)
    expect(
      UserToolConfirmationEventInputSchema.safeParse({
        ...body,
        result: 'allow',
        deny_message: 'because',
      }).success,
    ).toBe(false)
    expect(
      UserToolConfirmationEventInputSchema.safeParse({
        ...body,
        result: 'deny',
        deny_message: 'I would rather not',
      }).success,
    ).toBe(true)
  })
})
