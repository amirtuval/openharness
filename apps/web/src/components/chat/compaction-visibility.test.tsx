import { contextMeter } from '@openharness/client'
import type {
  ContextMeter as ContextMeterValue,
  TranscriptMessage,
  TranscriptSummary,
  TranscriptTruncation,
} from '@openharness/client'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ContextMeter } from './context-meter'
import { MessageList } from './message-list'
import { SummaryDivider } from './summary-divider'
import { TruncationNotice } from './truncation-notice'

/**
 * What a chat shows while its context is being compacted (epic #277, K10; #280).
 *
 * The state is the client's — {@link SummaryDivider}, {@link ContextMeter} and
 * {@link TruncationNotice} are props in, markup out — so these tests draw each of them with a
 * value a transcript really produces and assert what a reader sees. The wiring that gets the
 * values here (the hook, the header, the reducer) belongs to `chat-view.tsx` and
 * `packages/client`, and the rules behind them are tested where they live.
 */

/** A message, with whatever the case is about overridden. */
function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  const text = overrides.text ?? 'Hello.'
  return {
    id: 'sevt_message',
    role: 'agent',
    // `text` is the parts joined, so an override of one has to carry the other: `MessageItem`
    // draws the parts.
    text,
    parts: [{ type: 'text', text }],
    pending: false,
    streaming: false,
    position: 1,
    ...overrides,
  }
}

/** A summary, with the divider's defaults and whatever the case overrides. */
function summary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    id: 'sevt_summary',
    summary: 'They greeted each other, then discussed the markdown renderer.',
    reason: 'threshold',
    model: 'anthropic/claude-sonnet-5',
    passes: 2,
    tokensBefore: 51_200,
    position: 2,
    seq: 3,
    ...overrides,
  }
}

/** The model the meter is drawn against: 100k window, so an 80k budget. */
const MODEL = { context_window: 100_000, max_output_tokens: 20_000 }

/** The meter a transcript with `tokens` in it produces, or a failure if it produces none. */
function meterFor(
  tokens: number,
  options: { readonly estimated?: boolean; readonly threshold?: number } = {},
): ContextMeterValue {
  const meter = contextMeter(
    { tokens, estimated: options.estimated ?? false },
    { model: MODEL, ...(options.threshold === undefined ? {} : { threshold: options.threshold }) },
  )
  if (meter === null) {
    throw new Error('a measured context must have a meter')
  }
  return meter
}

describe('SummaryDivider (#280)', () => {
  it('marks the conversation without giving the summary away', () => {
    const { container } = render(<SummaryDivider summary={summary()} />)

    expect(container.querySelector('[data-slot="summary-divider"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Conversation summarized/ })).toBeInTheDocument()
    // Collapsed: the mark is on screen and the text it stands for is not.
    expect(screen.queryByText(/discussed the markdown/)).not.toBeInTheDocument()
  })

  it('says why, on what model and in how many passes', () => {
    render(<SummaryDivider summary={summary()} />)

    const description = screen.getByText(/automatic/)
    expect(description).toHaveTextContent('automatic · anthropic/claude-sonnet-5 · 2 passes')
  })

  it('calls the reason a reader asked for by its own name', () => {
    const { rerender } = render(<SummaryDivider summary={summary({ reason: 'manual' })} />)
    expect(screen.getByText(/manual/)).toBeInTheDocument()

    rerender(<SummaryDivider summary={summary({ reason: 'overflow' })} />)
    expect(screen.getByText(/overflow/)).toBeInTheDocument()
  })

  it('opens to the summary when the reader asks', async () => {
    const user = userEvent.setup()
    render(<SummaryDivider summary={summary()} />)

    const trigger = screen.getByRole('button', { name: /Conversation summarized/ })
    await user.click(trigger)

    expect(screen.getByText(/discussed the markdown/)).toBeInTheDocument()
    // The trigger is a disclosure, so its state is on the record rather than only in the chevron.
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('ContextMeter (#280)', () => {
  it('says how full the context is', () => {
    const { container } = render(<ContextMeter meter={meterFor(49_600)} />)

    expect(screen.getByText('62% of context used')).toBeInTheDocument()
    // The bar is the same fact drawn; the fill is the percentage.
    expect(container.querySelector('[data-slot="context-meter-fill"]')).toHaveStyle({
      width: '62%',
    })
  })

  it('is normal until the context reaches the threshold it compacts at', () => {
    const { container, rerender } = render(<ContextMeter meter={meterFor(49_600)} />)
    const meter = (): Element | null => container.querySelector('[data-slot="context-meter"]')

    expect(meter()).toHaveAttribute('data-state', 'normal')

    rerender(<ContextMeter meter={meterFor(60_000)} />)
    expect(meter()).toHaveAttribute('data-state', 'near')
  })

  it('marks where the chat compacts, and takes the caller’s threshold', () => {
    const { container } = render(<ContextMeter meter={meterFor(44_000, { threshold: 0.5 })} />)

    // The mark is at the share the chat compacts at, so "how close is it?" is a glance and not
    // a sum.
    expect(container.querySelector('[data-slot="context-meter-threshold"]')).toHaveStyle({
      left: '50%',
    })
    expect(container.querySelector('[data-slot="context-meter"]')).toHaveAttribute(
      'data-state',
      'near',
    )
  })

  it('says when the number is an estimate', () => {
    const { container } = render(<ContextMeter meter={meterFor(49_600, { estimated: true })} />)

    expect(screen.getByText('~62% of context used')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="context-meter"]')).toHaveAttribute(
      'data-estimated',
      'true',
    )
  })

  it('carries the short form for a header with no room for the sentence', () => {
    render(<ContextMeter meter={meterFor(49_600)} />)

    // Both spellings are in the markup and a media query picks one, so nothing has to measure
    // the viewport to know which to draw.
    expect(screen.getByText('62%')).toBeInTheDocument()
  })
})

describe('TruncationNotice (#280)', () => {
  const truncation: TranscriptTruncation = {
    seq: 4,
    tokensBefore: 900,
    tokensAfter: 300,
    recordedAt: 6,
  }

  it('tells the reader their message was shortened', () => {
    render(<TruncationNotice truncation={truncation} />)

    expect(
      screen.getByText('Your message was too long for this model and was shortened.'),
    ).toBeInTheDocument()
  })

  it('says how much was left out, in the tooltip rather than the line', () => {
    render(<TruncationNotice truncation={truncation} />)

    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      'About 600 tokens of it were left out of the request.',
    )
  })
})

describe('MessageList with a summary in it (#280)', () => {
  it('draws the divider where the history it covers ends', () => {
    render(
      <MessageList
        messages={[
          message({ id: 'sevt_1', role: 'user', text: 'first', position: 1 }),
          message({ id: 'sevt_2', text: 'second', position: 2 }),
          message({ id: 'sevt_3', role: 'user', text: 'third', position: 5 }),
        ]}
        summaries={[summary({ id: 'sevt_sum', position: 2 })]}
        loading={false}
      />,
    )

    // The divider is a mark *in* the conversation: everything it covers is still on screen,
    // above it, and the messages after it are still below.
    const text = screen.getByRole('log').textContent ?? ''
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('Conversation summarized'))
    expect(text.indexOf('Conversation summarized')).toBeLessThan(text.indexOf('third'))
  })

  it('draws the truncation notice at the foot of the transcript', () => {
    render(
      <MessageList
        messages={[message({ id: 'sevt_1', role: 'user', text: 'a very long message' })]}
        truncation={{ seq: 1, tokensBefore: 900, tokensAfter: 300, recordedAt: 3 }}
        loading={false}
      />,
    )

    expect(screen.getByText(/was too long for this model/)).toBeInTheDocument()
  })

  it('draws neither when the conversation has neither', () => {
    render(
      <MessageList
        messages={[message({ id: 'sevt_1', role: 'user', text: 'hello' })]}
        loading={false}
      />,
    )

    expect(screen.queryByText('Conversation summarized')).not.toBeInTheDocument()
    expect(screen.queryByText(/was too long for this model/)).not.toBeInTheDocument()
  })
})
