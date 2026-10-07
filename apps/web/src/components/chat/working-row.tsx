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
}

/**
 * Which row to draw, or none — a pure function so the rule is testable without a render.
 *
 * The order is the whole of it: an interrupt outranks everything (it is the reader's own,
 * most recent action), a running session that has text needs no row, and a running one
 * without text is either retrying or working. Anything else is no row at all.
 */
export function workingState(input: WorkingRowInput): WorkingState | null {
  if (input.interrupted) {
    return { kind: 'interrupted' }
  }
  if (input.status !== 'running') {
    return null
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

  const label =
    state.kind === 'working' ? 'Working…' : state.kind === 'retrying' ? 'Retrying…' : 'Interrupted'

  return (
    <div
      role="status"
      data-slot="working-row"
      data-state={state.kind}
      className="flex items-center gap-inline text-sm text-muted-foreground"
    >
      {state.kind === 'working' ? (
        <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
      ) : state.kind === 'retrying' ? (
        <span
          aria-hidden="true"
          className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500"
        />
      ) : (
        <Square aria-hidden="true" className="size-3 shrink-0" />
      )}
      <span>{label}</span>
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
