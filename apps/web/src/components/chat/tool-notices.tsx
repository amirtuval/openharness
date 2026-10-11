import { TOOLS_UNSUPPORTED_NOTICE } from '@openharness/client'
import { CircleAlert, Info, Scissors, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The lines a reader is owed because tools were involved (epic #303, X2/X5/X9; issue #308).
 *
 * Four things the log says that no message says, drawn together at the foot of the transcript
 * where the newest thing happened:
 *
 * - **the step limit** — the turn reached its model-request budget before the model finished
 *   (X2). The brain's own `session.error` carries the sentence ("This turn reached its limit of
 *   50 …"), and `stepLimitNotice` hands it over; the chat draws this instead of the red error
 *   banner for that one error type, because it is a notice rather than a failure to retry.
 * - **this model can't use tools** — the catalog's `tool_call` is `false`, so no request will
 *   offer one, and the reader should not wait for a call that cannot come.
 * - **results were shortened**, and **old results were cleared** — the request had to cap a
 *   tool's answer or replace an older one to fit the model (X9, #306). Both are the request's own
 *   record, and both mean the model saw less than the transcript shows.
 *
 * The words are the client's (`stepLimitNotice`, `truncatedResultsNotice`,
 * `clearedResultsNotice`, `TOOLS_UNSUPPORTED_NOTICE`), so `oh` says the same thing.
 */
export function ToolNotices({
  stepLimit = null,
  unsupported = false,
  truncated = null,
  cleared = null,
}: {
  /** The step-limit notice, or `null` (epic #303, X2). */
  stepLimit?: string | null
  /** Whether the chat's model cannot call tools at all (epic #303, X2). */
  unsupported?: boolean
  /** What a request shortened, or `null` (epic #303, X9; #306). */
  truncated?: string | null
  /** What a request cleared, or `null` (epic #303, X9; #306). */
  cleared?: string | null
}) {
  if (stepLimit === null && !unsupported && truncated === null && cleared === null) {
    return null
  }
  return (
    <div data-slot="tool-notices" className="flex flex-col gap-1">
      {stepLimit === null ? null : (
        <NoticeLine slot="step-limit-notice" tone="warning" Icon={TriangleAlert} text={stepLimit} />
      )}
      {unsupported ? (
        <NoticeLine
          slot="tools-unsupported-notice"
          tone="muted"
          Icon={Info}
          text={TOOLS_UNSUPPORTED_NOTICE}
        />
      ) : null}
      {truncated === null ? null : (
        <NoticeLine slot="tool-truncation-notice" tone="muted" Icon={Scissors} text={truncated} />
      )}
      {cleared === null ? null : (
        <NoticeLine slot="tool-cleared-notice" tone="muted" Icon={CircleAlert} text={cleared} />
      )}
    </div>
  )
}

/** One notice line: an icon, a sentence, and the tone that picks both colours. */
function NoticeLine({
  slot,
  tone,
  Icon,
  text,
}: {
  slot: string
  tone: 'warning' | 'muted'
  Icon: typeof Info
  text: string
}): ReactNode {
  return (
    <p
      role="status"
      data-slot={slot}
      data-tone={tone}
      className={
        tone === 'warning'
          ? 'flex items-start gap-inline text-xs text-coral-ink'
          : 'flex items-start gap-inline text-xs text-muted-foreground'
      }
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
}
