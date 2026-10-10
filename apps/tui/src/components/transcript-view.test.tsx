import type { TranscriptMessage, TranscriptSummary } from '@openharness/client'
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
    readonly holdAll?: boolean
    readonly summaries?: readonly TranscriptSummary[]
    readonly costOf?: (modelId: string) => {
      input: number
      output: number
      cache_read: number | null
      cache_write: number | null
    } | null
  } = {},
) {
  return render(
    <ThemeProvider theme={{ background: 'dark', color: true, level: 3 }}>
      <TranscriptView
        messages={messages}
        summaries={options.summaries}
        width={options.width ?? 40}
        currentModel={options.currentModel}
        holdLive={options.holdLive}
        holdAll={options.holdAll}
        costOf={options.costOf}
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
  options: {
    readonly width?: number
    readonly currentModel?: string
    readonly summaries?: readonly TranscriptSummary[]
    readonly costOf?: (modelId: string) => {
      input: number
      output: number
      cache_read: number | null
      cache_write: number | null
    } | null
  } = {},
): string {
  return (viewOf(messages, options).lastFrame() ?? '').trimEnd()
}

/** The transcript redrawn with new props, as React would on a new prop value. */
function redraw(
  app: ReturnType<typeof viewOf>,
  messages: readonly TranscriptMessage[],
  options: {
    readonly width?: number
    readonly currentModel?: string
    readonly holdLive?: string
    readonly summaries?: readonly TranscriptSummary[]
  } = {},
): void {
  app.rerender(
    <ThemeProvider theme={{ background: 'dark', color: true, level: 3 }}>
      <TranscriptView
        messages={messages}
        summaries={options.summaries}
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

    expect(frame).toBe('hi\n\nhello there')
  })

  it('does not open the transcript with a blank line', () => {
    expect(frameOf([message('sevt_1', 'hi', 'user')])).toBe('hi')
  })

  it('separates a message that is still streaming from the one before it', () => {
    const frame = frameOf([
      message('sevt_1', 'hi', 'user'),
      message('sevt_2', 'arriving…', 'agent', { streaming: true }),
    ])

    expect(frame).toBe('hi\n\narriving…▌')
  })

  it('keeps a blank line between two messages, not between the blocks of one', () => {
    const frame = frameOf([
      message('sevt_1', '- one\n- two', 'agent'),
      message('sevt_2', 'ok', 'user'),
    ])

    expect(frame).toBe('• one\n• two\n\nok')
  })
})

describe('the blank lines around a user message (issue #229)', () => {
  it('sets a banded message off from the reply above and the reply below', () => {
    // The bands are what the blank lines are for. The message brings them itself, so the
    // transcript does not draw its separator as well: one blank line either side, not two.
    const frame = frameOf([
      message('sevt_1', 'first', 'agent'),
      message('sevt_2', 'hi', 'user'),
      message('sevt_3', 'second', 'agent'),
    ])

    expect(frame).toBe('first\n\nhi\n\nsecond')
  })

  it('leaves one blank line between two user messages, not one each', () => {
    // Steering queues a second message behind a first that has not been sent yet, so this is
    // two bands in a row: the first ends in a blank line and the second does not start with
    // another.
    const frame = frameOf([message('sevt_1', 'one', 'user'), message('sevt_2', 'two', 'user')])

    expect(frame).toBe('one\n\ntwo')
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
            usage: { input: 1000, output: 300, cacheCreation: 0, cacheRead: 0, total: 1300 },
          },
        }),
        message('sevt_3', 'ok', 'user'),
      ],
      { currentModel: MODEL },
    )

    expect(frame).toBe('hi\n\nhello there\n\n4.2s · 1.3k tokens\n\nok')
  })

  it('holds a reply live until its metadata arrives, so `<Static>` cannot lose the line', () => {
    // The span end lands after the reply does, which is the whole reason for the hold: a
    // message that has settled is written once and never redrawn.
    const early = message('sevt_1', 'hello', 'agent', { meta: { model: MODEL } })
    const late = message('sevt_1', 'hello', 'agent', {
      meta: { model: MODEL, durationMs: 4200 },
    })

    const app = viewOf([early], { currentModel: MODEL, holdLive: 'sevt_1' })
    expect(app.lastFrame()).toBe('hello')

    redraw(app, [late], { currentModel: MODEL, holdLive: 'sevt_1' })
    expect(app.lastFrame()).toBe('hello\n\n4.2s')
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
    expect(app.lastFrame()).toBe('hello\n')

    redraw(app, [late], { currentModel: MODEL })
    expect(app.lastFrame()).toBe('hello\n')
  })

  it('draws no line at all for a reply whose metadata says nothing', () => {
    // The model is the one the session runs — the status line is already showing it — so the
    // reply has nothing to add: no dashes, no empty line.
    expect(
      frameOf([message('sevt_1', 'hello', 'agent', { meta: { model: MODEL } })], {
        currentModel: MODEL,
      }),
    ).toBe('hello')
  })

  it('has no line for a reply the log said nothing about', () => {
    expect(frameOf([message('sevt_1', 'hello')])).toBe('hello')
  })
})

describe('holding the transcript until the prices are read (#247)', () => {
  const withUsage = message('sevt_1', 'Hello there.', 'agent', {
    meta: {
      model: 'anthropic/claude-sonnet-5',
      usage: { input: 1000, output: 200, cacheCreation: 0, cacheRead: 0, total: 1200 },
    },
  })
  const priced = () => ({ input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 })

  it('costs every footer once the catalog is there', () => {
    const frame = frameOf([withUsage], { costOf: priced })
    // 1,000 in at $2/Mtok and 200 out at $10/Mtok: $0.004.
    expect(frame).toContain('$0.004')
  })

  it('draws no cost while the prices are still being read, and holds nothing back', () => {
    // With `holdAll` the messages are drawn (live), so a reader sees the conversation — they
    // are simply not settled yet, which is the only way their footer can still gain a cost:
    // Ink writes a settled message once and never redraws it (#208, X2).
    const held = viewOf([withUsage], { holdAll: true }).lastFrame() ?? ''
    expect(held).toContain('Hello there.')
    expect(held).not.toContain('$')
  })
})

/**
 * The summary dividers in the transcript (epic #277, K10; #280).
 *
 * A divider is a block like a message: it is ordered among them by the client's
 * `transcriptEntries`, and the blank lines the transcript draws between blocks are about it too.
 * The history it covers stays exactly where it was — the divider is a mark *in* the
 * conversation, not a replacement for any part of it.
 */
describe('the summary dividers (#280)', () => {
  /** A divider, with the fields the transcript's layout does not read filled in. */
  function divider(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
    return {
      id: 'sevt_summary',
      summary: 'They greeted each other.',
      reason: 'threshold',
      model: 'anthropic/claude-sonnet-5',
      passes: 1,
      tokensBefore: 51_200,
      position: 2,
      seq: 3,
      ...overrides,
    }
  }

  it('draws the divider between the messages it stands between', () => {
    const frame = frameOf(
      [message('sevt_1', 'hi', 'user'), message('sevt_5', 'and then', 'agent')],
      { summaries: [divider({ position: 2 })], width: 60 },
    )

    // One blank line before the mark and one after it, and the messages it covers are still
    // printed — a summary supersedes nothing.
    expect(frame.split('\n')).toEqual([
      'hi',
      '',
      expect.stringContaining('conversation summarized'),
      'They greeted each other.',
      '',
      'and then',
    ])
  })

  it('leaves the divider where the history it covers ends', () => {
    const frame = frameOf(
      [
        message('sevt_1', 'first', 'agent'),
        message('sevt_2', 'second', 'agent'),
        message('sevt_9', 'third', 'agent'),
      ],
      // The divider covers the first two messages: it belongs after `second`, not after `third`.
      { summaries: [divider({ position: 2 })], width: 60 },
    )

    expect(frame.split('\n')[4]).toContain('conversation summarized')
  })

  it('keeps a divider and the block above it one blank line apart', () => {
    // A banded user message already ends in a blank line, so the divider must not add another.
    const frame = frameOf([message('sevt_1', 'hi', 'user')], {
      summaries: [divider({ position: 1 })],
      width: 60,
    })

    expect(frame.split('\n')[1]).toBe('')
    expect(frame.split('\n')[2]).toContain('conversation summarized')
  })

  it('draws a divider that arrives once the history under it is already written (#298)', () => {
    // The compaction runs at the start of a turn, so its divider covers history the terminal
    // has long since committed to `<Static>` — the scrollback, which Ink never redraws. The
    // divider must still be drawn (the web draws it), just appended rather than inserted, and
    // the settled messages must not be written a second time.
    const messages = [
      message('sevt_1', 'first', 'user'),
      message('sevt_2', 'second', 'agent'),
      message('sevt_3', 'third', 'agent'),
    ]
    const app = viewOf(messages, { width: 60 })
    expect(app.lastFrame()).not.toContain('conversation summarized')

    redraw(app, messages, { summaries: [divider({ position: 2 })], width: 60 })

    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('conversation summarized')
    // The summary the divider opens to is drawn under it in the terminal too (#280).
    expect(frame).toContain('They greeted each other.')
    // Nothing the scrollback already held is written again.
    expect(frame.match(/third/gu)).toHaveLength(1)
    expect(frame.match(/first/gu)).toHaveLength(1)
  })
})
