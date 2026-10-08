import { replyCost } from '@openharness/client'
import type { ModelPriceLookup, TranscriptMessage, TranscriptUsage } from '@openharness/client'
import { Fragment, type ReactNode } from 'react'

import { formatCost, formatCount, formatDuration, modelLabel } from '../../lib/format'
import type { ModelNameLookup } from '../../lib/models'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/**
 * What a reply cost, in one low-contrast line under it (#212).
 *
 *     Claude Sonnet 5 · 4.2s · 1,312 tokens · $0.0013
 *
 * The transcript used to end at the answer, and everything the log knew about how it was
 * produced — the model that served it (#201, U1) and what it spent — had no reader. The line
 * is the smallest thing that gives them one: quiet enough to be skippable, present enough that
 * "which model answered this, and was it slow?" is answered without opening anything.
 *
 * Three rules, and they are all the same rule — a line that guesses is worse than a short line:
 *
 * - **Every part is optional and unknown parts are left out.** A reply whose span never closed
 *   has no duration and no tokens, one that ran on an unreadable log has no model, and a reply
 *   with none of the three draws nothing at all ({@link TranscriptMessageMeta} keeps "unknown"
 *   and `0` apart, and this is why that matters here).
 * - **The model is named only when it is news** — when it differs from the previous reply's,
 *   which is why the caller passes that in ({@link previousReplyModels}). A chat that ran on
 *   one model the whole way says it once; a reply that switched engines says so, and the
 *   "Switched to …" marker above it (#113, U3) is where the reader can see why.
 * - **The tokens are a total, and the split is a hover away.** `total` is what a reader thinks
 *   in; input and output are what a reader who is counting spends, so they are in the tooltip
 *   rather than in the line.
 * - **The cost is computed here, from the catalog's prices** (epic #245, A2; #247). The log
 *   stores tokens and never money, so the reply's own counters are priced with its model's
 *   rates when the row is drawn; a model nobody prices shows `—`, which is the honest answer
 *   and never a zero.
 */
export function MessageMeta({
  message,
  previousModel,
  nameOf,
  costOf,
}: {
  /** The reply. Anything that is not an agent message has no metadata to draw. */
  message: TranscriptMessage
  /** The previous reply's model, or `undefined` when there was none. */
  previousModel: string | undefined
  /** The catalog lookup for the model's display name; the id when the catalog does not know it. */
  nameOf?: ModelNameLookup | undefined
  /**
   * The catalog's prices (epic #245, A2; #247), for the reply's cost. Omitted — a caller that
   * has no catalog — the cost is left out of the line rather than guessed at.
   */
  costOf?: ModelPriceLookup | undefined
}): ReactNode {
  const meta = message.role === 'agent' ? message.meta : undefined
  if (meta === undefined) {
    return null
  }

  const items: ReactNode[] = []
  if (meta.model !== undefined && meta.model !== previousModel) {
    items.push(
      <span key="model" data-slot="message-model">
        {modelLabel(meta.model, nameOf)}
      </span>,
    )
  }
  if (meta.durationMs !== undefined) {
    items.push(
      <span key="duration" data-slot="message-duration">
        {formatDuration(meta.durationMs)}
      </span>,
    )
  }
  if (meta.usage !== undefined) {
    items.push(<TokenTotal key="tokens" usage={meta.usage} />)
    if (costOf !== undefined) {
      // `null` — a model the catalog does not price — draws as `—`: the tokens are real, the
      // money is not known, and the two must not look alike.
      items.push(
        <span key="cost" data-slot="message-cost">
          {formatCost(replyCost(meta, costOf))}
        </span>,
      )
    }
  }
  if (items.length === 0) {
    return null
  }

  return (
    <p
      data-slot="message-meta"
      className="flex min-w-0 flex-wrap items-center gap-x-1 text-2xs text-muted-foreground/80"
    >
      {items.map((item, index) => (
        // The middot is decoration — a screen reader that read it out would be reading
        // punctuation as a word — and the spaces around it are the opposite: a flex container
        // does not render a whitespace-only child, so they cost nothing on screen and keep
        // the line from being read (and copied) as one long word. The visual spacing is the
        // row's own `gap-x-1`.
        <Fragment key={index}>
          {index === 0 ? null : (
            <>
              {' '}
              <span aria-hidden="true" data-slot="meta-separator">
                ·
              </span>{' '}
            </>
          )}
          {item}
        </Fragment>
      ))}
    </p>
  )
}

/**
 * The reply's tokens, and their split on hover.
 *
 * The trigger is focusable (`tabIndex={0}`) on purpose: the tooltip is the only place the
 * input/output split exists, and a tooltip a keyboard cannot reach is a tooltip for half the
 * readers. It is one tab stop per reply, which is the price of the number having a second half.
 */
function TokenTotal({ usage }: { usage: TranscriptUsage }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-slot="message-tokens" tabIndex={0} className="rounded-xs">
          {formatCount(usage.total)} {usage.total === 1 ? 'token' : 'tokens'}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {formatCount(usage.input)} input · {formatCount(usage.output)} output
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The model each message should compare its own against: the previous *reply's* model.
 *
 * A flat list keyed by index, the same length as `messages`, holding `undefined` for every
 * message that is not a reply — which is what makes the caller's `map` a one-liner rather than
 * a loop with a carried variable. Only an agent message advances it: a user message carries no
 * model of its own (`modelChangedTo` is the session's, not this reply's), so a reply compares
 * against the last reply, not against the message above it.
 */
export function previousReplyModels(
  messages: readonly TranscriptMessage[],
): (string | undefined)[] {
  let previous: string | undefined
  return messages.map((message) => {
    const here = previous
    if (message.role === 'agent' && message.meta?.model !== undefined) {
      previous = message.meta.model
    }
    return here
  })
}
