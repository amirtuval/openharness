import type { TranscriptMessage } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from './theme'
import { TranscriptView } from './transcript-view'

/** A settled message, unless a flag says otherwise. */
function message(
  id: string,
  text: string,
  role: 'user' | 'agent' = 'agent',
  overrides: Partial<TranscriptMessage> = {},
): TranscriptMessage {
  return {
    id,
    role,
    text,
    parts: [{ type: 'text', text }],
    pending: false,
    streaming: false,
    position: Number(id.replace(/\D/gu, '')),
    ...overrides,
  }
}

/**
 * What the transcript drew, as one string.
 *
 * Trailing whitespace is trimmed because Ink's `<Static>` closes its output with a newline —
 * a blank line at the end of the frame says nothing about the transcript.
 */
function frameOf(messages: readonly TranscriptMessage[], width = 40): string {
  const { lastFrame } = render(
    <ThemeProvider theme={{ background: 'dark', color: true }}>
      <TranscriptView messages={messages} width={width} />
    </ThemeProvider>,
  )
  return (lastFrame() ?? '').trimEnd()
}

afterEach(() => {
  cleanup()
})

describe('TranscriptView', () => {
  it('separates two messages with one blank line', () => {
    const frame = frameOf([
      message('sevt_1', 'hi', 'user'),
      message('sevt_2', 'hello there', 'agent'),
    ])

    expect(frame).toBe('you › hi\n\nagent › hello there')
  })

  it('does not open the transcript with a blank line', () => {
    expect(frameOf([message('sevt_1', 'hi', 'user')])).toBe('you › hi')
  })

  it('separates a message that is still streaming from the one before it', () => {
    const frame = frameOf([
      message('sevt_1', 'hi', 'user'),
      message('sevt_2', 'arriving…', 'agent', { streaming: true }),
    ])

    expect(frame).toBe('you › hi\n\nagent › arriving…▌')
  })

  it('keeps a blank line between two messages, not between the blocks of one', () => {
    const frame = frameOf([
      message('sevt_1', '- one\n- two', 'agent'),
      message('sevt_2', 'ok', 'user'),
    ])

    expect(frame).toBe('agent › • one\n        • two\n\nyou › ok')
  })
})
