import type { TranscriptTruncation } from '@openharness/client'
import { Scissors } from 'lucide-react'

/**
 * "Your message was too long for this model and was shortened" (epic #277, K6/K10; #280).
 *
 * The one compaction fact that is about the reader's own message rather than about the model's
 * bookkeeping: the newest message alone was over the chat model's budget, so the request carried
 * it capped to a head and a tail around an omission marker. The transcript still shows the whole
 * message — nothing is edited — which is exactly why this notice has to exist: what the reader
 * wrote and what the model was sent are not the same text, and only the log knows.
 *
 * It sits at the foot of the transcript, where the newest message is, and it is drawn from the
 * **newest** request's record: a later request that capped nothing clears it, so the notice
 * cannot outlive the turn it was about.
 */
export function TruncationNotice({ truncation }: { truncation: TranscriptTruncation }) {
  const omitted = Math.max(0, truncation.tokensBefore - truncation.tokensAfter)
  return (
    <div
      role="status"
      data-slot="truncation-notice"
      title={`About ${String(omitted)} tokens of it were left out of the request.`}
      className="flex items-start gap-inline text-xs text-muted-foreground"
    >
      <Scissors aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-coral" />
      <span>Your message was too long for this model and was shortened.</span>
    </div>
  )
}
