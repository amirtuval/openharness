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

/** The transcript, mounted, for a test that has to redraw it with a new conversation. */
function viewOf(
  messages: readonly TranscriptMessage[],
  options: {
    readonly width?: number
    readonly currentModel?: string
    readonly holdLive?: string
  } = {},
) {
  return render(
    <ThemeProvider theme={{ background: 'dark', color: true }}>
      <TranscriptView
        messages={messages}
        width={options.width ?? 40}
        currentModel={options.currentModel}
        holdLive={options.holdLive}
      />
    </ThemeProvider>,
  )
}

/**
 * What the transcript drew, as one string.
 *
 * Trailing whitespace is trimmed because Ink's `<Static>` closes its output with a newline —
 * a blank line at the end of the frame says nothing about the transcript.
 */
function frameOf(
  messages: readonly TranscriptMessage[],
  options: { readonly width?: number; readonly currentModel?: string } = {},
): string {
  return (viewOf(messages, options).lastFrame() ?? '').trimEnd()
}

/** The transcript redrawn with the same messages, as React would on a new prop value. */
function redraw(
  app: ReturnType<typeof viewOf>,
  messages: readonly TranscriptMessage[],
  options: {
    readonly width?: number
    readonly currentModel?: string
    readonly holdLive?: string
  } = {},
): void {
  app.rerender(
    <ThemeProvider theme={{ background: 'dark', color: true }}>
      <TranscriptView
        messages={messages}
        width={options.width ?? 40}
        currentModel={options.currentModel}
        holdLive={options.holdLive}
      />
    </ThemeProvider>,
  )
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

describe('per-reply metadata (issue #208)', () => {
  const MODEL = 'anthropic/claude-sonnet-5'

  it('prints the metadata line under the reply it belongs to', () => {
    const frame = frameOf(
      [
        message('sevt_1', 'hi', 'user'),
        message('sevt_2', 'hello there', 'agent', {
          meta: {
            model: MODEL,
            durationMs: 4200,
            usage: { input: 1000, output: 300, total: 1300 },
          },
        }),
        message('sevt_3', 'ok', 'user'),
      ],
      { currentModel: MODEL },
    )

    expect(frame).toBe('you › hi\n\nagent › hello there\n        4.2s · 1.3k tokens\n\nyou › ok')
  })

  it('holds a reply live until its metadata arrives, so `<Static>` cannot lose the line', () => {
    // The span end lands after the reply does, which is the whole reason for the hold: a
    // message that has settled is written once and never redrawn.
    const early = message('sevt_1', 'hello', 'agent', { meta: { model: MODEL } })
    const late = message('sevt_1', 'hello', 'agent', {
      meta: { model: MODEL, durationMs: 4200 },
    })

    const app = viewOf([early], { currentModel: MODEL, holdLive: 'sevt_1' })
    expect(app.lastFrame()).toBe('agent › hello')

    redraw(app, [late], { currentModel: MODEL, holdLive: 'sevt_1' })
    expect(app.lastFrame()).toBe('agent › hello\n        4.2s')
  })

  it('is what the hold is for: a settled reply never picks the line up', () => {
    // The same redraw without the hold — which is what the transcript did before #208. The
    // frame is unchanged, and no later redraw can bring the metadata back: Ink has written
    // the message to the scrollback and will not write it again.
    const early = message('sevt_1', 'hello', 'agent', { meta: { model: MODEL } })
    const late = message('sevt_1', 'hello', 'agent', {
      meta: { model: MODEL, durationMs: 4200 },
    })

    const app = viewOf([early], { currentModel: MODEL })
    expect(app.lastFrame()).toBe('agent › hello\n')

    redraw(app, [late], { currentModel: MODEL })
    expect(app.lastFrame()).toBe('agent › hello\n')
  })

  it('draws no line at all for a reply whose metadata says nothing', () => {
    // The model is the one the session runs — the status line is already showing it — so the
    // reply has nothing to add: no dashes, no empty line.
    expect(
      frameOf([message('sevt_1', 'hello', 'agent', { meta: { model: MODEL } })], {
        currentModel: MODEL,
      }),
    ).toBe('agent › hello')
  })

  it('has no line for a reply the log said nothing about', () => {
    expect(frameOf([message('sevt_1', 'hello')])).toBe('agent › hello')
  })
})
