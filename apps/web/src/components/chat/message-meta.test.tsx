import type { TranscriptMessage, TranscriptMessageMeta } from '@openharness/client'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { modelNameLookup } from '../../lib/models'
import { MessageMeta, previousReplyModels } from './message-meta'

/**
 * The line under a reply (issue #212).
 *
 * Rendered directly rather than through the app: the rules here are about the *line* — which
 * of the three parts it has, and what it does with the ones the log did not say — and a
 * transcript that happened to produce them is a longer way to ask the same question. That the
 * app really draws one is `App.test.tsx`'s.
 */

const nameOf = modelNameLookup([
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    source: 'provider',
  },
])

/** A message, with whatever the case is about overridden. */
function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: 'sevt_reply',
    role: 'agent',
    text: 'Hello.',
    parts: [{ type: 'text', text: 'Hello.' }],
    pending: false,
    streaming: false,
    position: 1,
    ...overrides,
  }
}

/** A reply carrying whatever metadata the case is about. */
function reply(meta?: TranscriptMessageMeta): TranscriptMessage {
  return message(meta === undefined ? {} : { meta })
}

/** The line's text, or `null` when there is no line. */
function lineText(): string | null {
  return document.querySelector('[data-slot="message-meta"]')?.textContent ?? null
}

describe('MessageMeta', () => {
  it('reads as one sentence: the model, the time, the tokens', () => {
    render(
      <MessageMeta
        message={reply({
          model: 'anthropic/claude-sonnet-5',
          durationMs: 4200,
          usage: { input: 1100, output: 212, total: 1312 },
        })}
        previousModel={undefined}
        nameOf={nameOf}
      />,
    )

    // The catalog's display name, not the id — the same lookup the markers and the header use.
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument()
    expect(screen.getByText('4.2s')).toBeInTheDocument()
    expect(screen.getByText('1,312 tokens')).toBeInTheDocument()
    // And it reads as one sentence: the middots are drawn, and the text a screen reader or a
    // selection gets is separated by spaces rather than run together.
    expect(lineText()).toBe('Claude Sonnet 5 · 4.2s · 1,312 tokens')
  })

  it('names the model only when it is news', () => {
    const message = reply({ model: 'anthropic/claude-sonnet-5', durationMs: 900 })
    const { unmount } = render(
      <MessageMeta message={message} previousModel={undefined} nameOf={nameOf} />,
    )
    expect(lineText()).toContain('Claude Sonnet 5')
    unmount()

    // The same reply, after a reply on the same model: the id is repeated in the log for
    // every turn, and saying it every time would be a column of the same word.
    render(
      <MessageMeta message={message} previousModel="anthropic/claude-sonnet-5" nameOf={nameOf} />,
    )
    expect(lineText()).toBe('0.9s')
  })

  it('leaves out every part the log does not have', () => {
    const { unmount } = render(
      <MessageMeta
        message={reply({ model: 'anthropic/claude-sonnet-5' })}
        previousModel={undefined}
      />,
    )
    // Unknown model (the catalog does not know it) — the id is still what the log said.
    expect(lineText()).toBe('anthropic/claude-sonnet-5')
    unmount()

    // Nothing known at all is not an empty line: it is no line.
    render(<MessageMeta message={reply({})} previousModel={undefined} />)
    expect(lineText()).toBeNull()
  })

  it('shows nothing under a message with no metadata, or under the reader’s own', () => {
    const { unmount } = render(<MessageMeta message={reply()} previousModel={undefined} />)
    expect(lineText()).toBeNull()
    unmount()

    render(
      <MessageMeta
        message={{ ...reply({ model: 'anthropic/claude-sonnet-5' }), role: 'user' }}
        previousModel={undefined}
      />,
    )
    expect(lineText()).toBeNull()
  })

  it('puts the input and output split in the tooltip', async () => {
    const user = userEvent.setup()
    render(
      <MessageMeta
        message={reply({ usage: { input: 1100, output: 212, total: 1312 } })}
        previousModel={undefined}
      />,
    )

    // Only the total is in the line; the split is what the pointer (or the keyboard: the
    // trigger is focusable) is for.
    const total = screen.getByText('1,312 tokens')
    expect(screen.queryByText(/input/)).toBeNull()
    await user.hover(total)
    expect(await screen.findByText('1,100 input · 212 output')).toBeInTheDocument()
  })

  it('says "token" for one of them', () => {
    render(
      <MessageMeta
        message={reply({ usage: { input: 1, output: 0, total: 1 } })}
        previousModel={undefined}
      />,
    )
    expect(screen.getByText('1 token')).toBeInTheDocument()
  })
})

describe('previousReplyModels', () => {
  it('hands each message the previous reply’s model', () => {
    const messages: TranscriptMessage[] = [
      message({ id: '1', position: 1, meta: { model: 'a' } }),
      message({ id: '2', position: 2, role: 'user' }),
      message({ id: '3', position: 3, meta: { model: 'a' } }),
      message({ id: '4', position: 4, meta: { model: 'b' } }),
      message({ id: '5', position: 5 }),
    ]

    expect(previousReplyModels(messages)).toEqual([undefined, 'a', 'a', 'a', 'b'])
  })
})
