import type { TranscriptManualCompaction } from '@openharness/client'
import { manualCompactionNotice } from '@openharness/client'
import { CircleAlert, Info } from 'lucide-react'

/**
 * What came of a manual compaction, when the reader has to be told (epic #277, K8; #283).
 *
 * `/compact [instructions]` is answered by the brain with a `session.compaction`, and two of the
 * three outcomes are the reader's business: `nothing_to_summarize` (there was no older history
 * the engine could cut away) and `failed` (the summarizer did not deliver). Both carry the
 * brain's own sentence where it has one — it knows why — and this is where it is shown, at the
 * foot of the transcript where the ask was made.
 *
 * `summarized` draws nothing here: the summary landed, and C5's "Conversation summarized"
 * divider is the outcome (`manualCompactionNotice` answers `null` for it). The words themselves
 * are the client's, so `oh` shows the same line for the same outcome.
 */
export function CompactionNotice({ compaction }: { compaction: TranscriptManualCompaction }) {
  const notice = manualCompactionNotice(compaction)
  if (notice === null) {
    return null
  }
  const failed = notice.tone === 'error'
  const Icon = failed ? CircleAlert : Info
  return (
    <div
      role="status"
      data-slot="compaction-notice"
      data-tone={notice.tone}
      className="flex items-start gap-inline text-xs text-muted-foreground"
    >
      <Icon
        aria-hidden="true"
        className={
          failed
            ? 'mt-0.5 size-3.5 shrink-0 text-destructive'
            : 'mt-0.5 size-3.5 shrink-0 text-coral'
        }
      />
      <span>{notice.text}</span>
    </div>
  )
}
