import type { SessionStatus } from '@openharness/protocol'
import { Loader2, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { formatElapsed } from '../../lib/format'
import { cn } from '../../lib/utils'

/**
 * What the end of the transcript says while a turn is in flight (epic #201, U10).
 *
 * The header's dot says *that* the session is running; it does not say for how long, it says
 * nothing at all about a retry, and it is nowhere near where the reader is looking. This row
 * is the same fact where the answer will appear, and it is the one place a long wait is
 * legible: a clock that counts up, a reason when the brain is retrying, and a word for what
 * happened when the reader stopped it.
 *
 * It is drawn **at the end of the conversation**, under the last message, because that is where
 * a reply will land — the header indicator stays exactly as it was.
 */
export type WorkingState =
  /** A turn is in flight and nothing has arrived yet. */
  | { readonly kind: 'working' }
  /**
   * The compaction engine is writing a summary, one pass at a time (epic #277, K10; #280).
   *
   * The chat's older history is being summarized, which is a wait like any other and a longer
   * one than a single request — so it says what it is doing and how far through it is, from the
   * `session.context_summary_progress` events rather than from a guess.
   */
  | { readonly kind: 'summarizing'; readonly pass: number; readonly passes: number }
  /** The brain hit a retryable error and is trying again, with the server's reason. */
  | { readonly kind: 'retrying'; readonly detail: string }
  /** The reader pressed Stop; the turn is over and this is what says so. */
  | { readonly kind: 'interrupted' }

/** What the row needs to decide what to show — the session, as the screen already knows it. */
export interface WorkingRowInput {
  readonly status: SessionStatus
  readonly retrying: boolean
  /** The retrying error's message, for the reason in brackets. */
  readonly retryReason: string | undefined
  /** The reader has asked to stop this turn and it has not been superseded by a new one. */
  readonly interrupted: boolean
  /** A reply has started arriving, in which case a "Working…" row would be a lie. */
  readonly hasReplyText: boolean
  /**
   * The summary being written right now, or `null` (epic #277, C2; #280).
   *
   * The transcript clears it when the summary lands, when the chat's own request starts, on an
   * error and on the turn ending, so a stale one cannot outrank the turn it was about.
   */
  readonly summarizing?: { readonly pass: number; readonly passes: number } | null | undefined
}

/**
 * Which row to draw, or none — a pure function so the rule is testable without a render.
 *
 * The order is the whole of it: an interrupt outranks everything (it is the reader's own,
 * most recent action); a session that is not running has nothing to report; a compaction
 * outranks a retry, because it is the newer statement about what the turn is doing (and a
 * summarizer's own failure ends it without a `session.error` at all); and a running session
 * that has text needs no row, so what is left is a retry or plain work. Anything else is no row.
 */
export function workingState(input: WorkingRowInput): WorkingState | null {
  if (input.interrupted) {
    return { kind: 'interrupted' }
  }
  if (input.status !== 'running') {
    return null
  }
  if (input.summarizing !== null && input.summarizing !== undefined) {
    return { kind: 'summarizing', pass: input.summarizing.pass, passes: input.summarizing.passes }
  }
  if (input.retrying) {
    return { kind: 'retrying', detail: input.retryReason ?? 'the model request failed' }
  }
  return input.hasReplyText ? null : { kind: 'working' }
}

/**
 * The row itself.
 *
 * The clock is the only state: it starts when the row appears and is dropped when it goes, so
 * the same wait is never counted twice, and a turn that goes from working to retrying keeps
 * counting instead of restarting — the reader waited through both.
 *
 * It is a live region (`role="status"`) so a screen reader hears "Working…" once, when it
 * starts. The ticking number is `aria-hidden`: a clock that announced itself every second
 * would be unusable, and the words are what matter.
 */
export function WorkingRow({ state }: { state: WorkingState }) {
  const live = state.kind !== 'interrupted'
  const [elapsedMs, setElapsedMs] = useState(0)
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!live) {
      startedAt.current = null
      setElapsedMs(0)
      return
    }
    startedAt.current ??= Date.now()
    const tick = (): void => {
      setElapsedMs(startedAt.current === null ? 0 : Date.now() - startedAt.current)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [live])

  return (
    <div
      role="status"
      data-slot="working-row"
      data-state={state.kind}
      className="flex items-center gap-inline text-sm text-muted-foreground"
    >
      {state.kind === 'working' || state.kind === 'summarizing' ? (
        <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-coral" />
      ) : state.kind === 'retrying' ? (
        <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-coral" />
      ) : (
        <Square aria-hidden="true" className="size-3 shrink-0" />
      )}
      <span>{rowLabel(state)}</span>
      {state.kind === 'retrying' ? (
        // The reason is the server's sentence: it can be long, so it is clipped rather than
        // allowed to push the clock off the row.
        <span className="min-w-0 truncate" title={state.detail}>
          ({state.detail})
        </span>
      ) : null}
      {live ? (
        <span aria-hidden="true" className={cn('shrink-0 tabular-nums')}>
          {formatElapsed(elapsedMs)}
        </span>
      ) : null}
    </div>
  )
}

/**
 * What the row says, per state.
 *
 * `summarizing` carries its own numbers rather than a plain "Working…": a compaction can take
 * several model calls, and "3 of 7" is the difference between a wait a reader can size and one
 * that looks stuck.
 */
function rowLabel(state: WorkingState): string {
  switch (state.kind) {
    case 'working':
      return 'Working…'
    case 'summarizing':
      return `Summarizing… ${String(state.pass)} of ${String(state.passes)}`
    case 'retrying':
      return 'Retrying…'
    case 'interrupted':
      return 'Interrupted'
  }
}
