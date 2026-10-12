import type { TranscriptMessage, TranscriptToolCall } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from './theme'
import { TranscriptView } from './transcript-view'

/**
 * Tool calls in the terminal's transcript (epic #303, X5; #308).
 *
 * The order comes from the client's `selectTranscriptEntries` (tested there); this file is what
 * the terminal draws: a call where its event sits, one blank line around it, and a call that is
 * still running kept in the live area so its status can change.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const

/** A settled message, at the position its id encodes. */
function message(id: string, text: string, role: 'user' | 'agent' = 'agent'): TranscriptMessage {
  return {
    id,
    role,
    text,
    parts: [{ type: 'text', text }],
    pending: false,
    streaming: false,
    position: Number(id.replace(/\D/gu, '')),
  }
}

/** A call at the position its id encodes. */
function call(
  id: string,
  name = 'web_fetch',
  overrides: Partial<TranscriptToolCall> = {},
): TranscriptToolCall {
  return {
    id,
    name,
    input: { url: 'https://example.com' },
    permission: 'allow',
    source: 'builtin',
    status: 'done',
    position: Number(id.replace(/\D/gu, '')),
    result: { content: 'ok', isError: false },
    ...overrides,
  }
}

function viewOf(messages: readonly TranscriptMessage[], toolCalls: readonly TranscriptToolCall[]) {
  return render(
    <ThemeProvider theme={DARK}>
      <TranscriptView messages={messages} toolCalls={toolCalls} width={48} />
    </ThemeProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('TranscriptView and tool calls (#308)', () => {
  it('draws a call between the messages around it, set off by one blank line', () => {
    const app = viewOf(
      [message('sevt_1', 'look this up', 'user'), message('sevt_3', 'It says hello.')],
      [call('sevt_2')],
    )

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('look this up')
    expect(frame).toContain('web_fetch')
    expect(frame).toContain('https://example.com')
    expect(frame).toContain('done')
    expect(frame).toContain('It says hello.')
    // One blank line between each block: the call brings its own above it, the reply its own.
    expect(frame).not.toContain('\n\n\n')
  })

  it('keeps a running call live so its status can change, and settles a finished one', () => {
    const running = call('sevt_2', 'web_fetch', { status: 'running', result: undefined })
    const app = viewOf([message('sevt_1', 'go', 'user')], [running])
    expect(app.lastFrame()).toContain('running')

    // Once the result lands the call settles; the frame then says what it came to.
    app.rerender(
      <ThemeProvider theme={DARK}>
        <TranscriptView
          messages={[message('sevt_1', 'go', 'user')]}
          toolCalls={[
            call('sevt_2', 'web_fetch', {
              status: 'done',
              result: { content: 'ok', isError: false },
            }),
          ]}
          width={48}
        />
      </ThemeProvider>,
    )
    expect(app.lastFrame()).toContain('done')
  })

  it('draws a failed call with the reason it did not finish', () => {
    const app = viewOf(
      [message('sevt_1', 'go', 'user')],
      [
        call('sevt_2', 'web_fetch', {
          status: 'error',
          result: { content: 'Tool web_fetch timed out after 30s', isError: true },
        }),
      ],
    )

    expect(app.lastFrame()).toContain('Tool web_fetch timed out after 30s')
  })
})
