import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workingState, WorkingRow, type WorkingRowInput } from './working-row'

/**
 * The row at the foot of the transcript (epic #201, U10).
 *
 * Two halves, tested apart because they are apart in the code: {@link workingState} is the rule
 * — which of the three rows, or none, for the session as the screen knows it — and the component
 * is the clock under it. The clock is the only reason this file needs fake timers, so it has
 * them; the rule needs nothing but the inputs.
 */

/** The inputs, with a working turn as the starting point. */
function input(overrides: Partial<WorkingRowInput> = {}): WorkingRowInput {
  return {
    status: 'running',
    retrying: false,
    retryReason: undefined,
    interrupted: false,
    hasReplyText: false,
    ...overrides,
  }
}

describe('workingState', () => {
  it('is a working row while a turn is in flight with nothing on screen', () => {
    expect(workingState(input())).toEqual({ kind: 'working' })
  })

  it('gets out of the way once the reply is arriving', () => {
    // The reply itself is the progress report from here on; a row saying "Working…" next to
    // text that is visibly being written would be noise.
    expect(workingState(input({ hasReplyText: true }))).toBeNull()
  })

  it('is nothing at all when the session is idle', () => {
    expect(workingState(input({ status: 'idle' }))).toBeNull()
    expect(workingState(input({ status: 'idle', retrying: true }))).toBeNull()
  })

  it('carries the server’s reason while it is retrying', () => {
    expect(
      workingState(input({ retrying: true, retryReason: 'The model is overloaded.' })),
    ).toEqual({ kind: 'retrying', detail: 'The model is overloaded.' })
  })

  it('still says something when a retry arrives with no message', () => {
    expect(workingState(input({ retrying: true }))).toEqual({
      kind: 'retrying',
      detail: 'the model request failed',
    })
  })

  it('is the reader’s own action first, whatever the session says', () => {
    // A stop outranks the status, the retry and the text: it is the most recent thing that
    // happened, and it is the only one of them the reader did.
    expect(workingState(input({ interrupted: true }))).toEqual({ kind: 'interrupted' })
    expect(workingState(input({ interrupted: true, status: 'idle', hasReplyText: true }))).toEqual({
      kind: 'interrupted',
    })
  })

  it('says a compaction is running, and how far through it is (#280)', () => {
    expect(workingState(input({ summarizing: { pass: 3, passes: 7 } }))).toEqual({
      kind: 'summarizing',
      pass: 3,
      passes: 7,
    })
  })

  it('reports a compaction over a retry and over plain work (#280)', () => {
    // The compaction is the newer statement about the same wait, and a summarizer's own
    // failure ends it without a `session.error` at all — so nothing else can outrank it.
    expect(
      workingState(input({ summarizing: { pass: 1, passes: 2 }, retrying: true })),
    ).toMatchObject({ kind: 'summarizing' })
    expect(
      workingState(input({ summarizing: { pass: 1, passes: 2 }, hasReplyText: true })),
    ).toEqual({ kind: 'summarizing', pass: 1, passes: 2 })
  })

  it('says nothing about a compaction while the session is not running (#280)', () => {
    // The transcript clears the progress on an idle, so this is belt and braces: a stale one
    // must not be drawn over a session that has stopped.
    expect(workingState(input({ status: 'idle', summarizing: { pass: 1, passes: 2 } }))).toBeNull()
  })
})

describe('WorkingRow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts the wait up from the moment it appears', () => {
    render(<WorkingRow state={{ kind: 'working' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    expect(screen.getByRole('status')).toHaveTextContent('0s')

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('3s')

    // Past a minute it keeps the seconds: a clock that stopped counting them would look stuck.
    act(() => {
      vi.advanceTimersByTime(62_000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('1m 05s')
  })

  it('names the reason it is retrying', () => {
    render(<WorkingRow state={{ kind: 'retrying', detail: 'The model is overloaded.' }} />)
    const row = screen.getByRole('status')
    expect(row).toHaveTextContent('Retrying…')
    expect(row).toHaveTextContent('(The model is overloaded.)')
    expect(row).toHaveAttribute('data-state', 'retrying')
  })

  it('names the pass a summary is on (#280)', () => {
    render(<WorkingRow state={{ kind: 'summarizing', pass: 3, passes: 7 }} />)
    const row = screen.getByRole('status')
    expect(row).toHaveTextContent('Summarizing… 3 of 7')
    expect(row).toHaveAttribute('data-state', 'summarizing')
    // A compaction is a wait like any other, so the clock runs for it too.
    expect(row).toHaveTextContent('0s')
  })

  it('says the turn was interrupted, and shows no clock for it', () => {
    // Nothing is being waited for any more, so there is nothing to count.
    render(<WorkingRow state={{ kind: 'interrupted' }} />)
    const row = screen.getByRole('status')
    expect(row).toHaveTextContent('Interrupted')
    expect(row).not.toHaveTextContent(/\d+s/)
    expect(row).toHaveAttribute('data-state', 'interrupted')

    // And it is not a live region that keeps re-announcing itself: the clock is the only thing
    // that changed, and it is `aria-hidden`.
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(row).not.toHaveTextContent(/\d+s/)
  })
})
