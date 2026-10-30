import { makeMode } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { statusModeLabel } from './screen'

/**
 * The status line's mode clause (#245, M6; #349, B8).
 *
 * The bug this exists for is the switch **away** from a mode: a pending plain model detaches
 * the chat on the next message, and the line used to keep naming the mode until it was sent.
 */

const MODE = makeMode({ name: 'deep' })
const other = makeMode({ name: 'fast' })

describe('statusModeLabel', () => {
  it('names the mode the chat follows', () => {
    expect(
      statusModeLabel([MODE, other], { modeId: MODE.id, pendingMode: null, pendingModel: null }),
    ).toBe('deep')
  })

  it('names a pending mode with "(next message)"', () => {
    expect(
      statusModeLabel([MODE, other], { modeId: null, pendingMode: other.id, pendingModel: null }),
    ).toBe('fast (next message)')
  })

  it('drops the mode the moment a plain model is picked (B8)', () => {
    // The session still follows the mode until the message is sent, but the switch must be
    // visible now — the model clause beside this one already names the pick.
    expect(
      statusModeLabel([MODE], {
        modeId: MODE.id,
        pendingMode: null,
        pendingModel: 'openai/gpt-4.1-mini',
      }),
    ).toBeUndefined()
  })

  it('is absent for a chat without a mode', () => {
    expect(
      statusModeLabel([MODE], { modeId: null, pendingMode: null, pendingModel: null }),
    ).toBeUndefined()
  })
})
