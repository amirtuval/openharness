import type { TranscriptTruncation } from '@openharness/client'
import { truncationNotice } from '@openharness/client'
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
 *
 * It is drawn only for a **message's** cut (#314): the transcript's own reading of the record
 * skips a request that shortened a tool result — that is `tool-notices.tsx`'s line — so the
 * sentence below is never about a fetch that came back too long. The words and the count come
 * from `@openharness/client`'s `truncationNotice`, so `oh` can say the same thing.
 */
export function TruncationNotice({ truncation }: { truncation: TranscriptTruncation }) {
  const notice = truncationNotice(truncation)
  return (
    <div
      role="status"
      data-slot="truncation-notice"
      title={notice.detail}
      className="flex items-start gap-inline text-xs text-muted-foreground"
    >
      <Scissors aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-coral" />
      <span>{notice.text}</span>
    </div>
  )
}
