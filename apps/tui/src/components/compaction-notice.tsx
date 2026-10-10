import type { TranscriptManualCompaction } from '@openharness/client'
import { manualCompactionNotice } from '@openharness/client'
import { Text } from 'ink'

/**
 * What came of a manual compaction, when the reader has to be told (epic #277, K8; #283).
 *
 * `/compact [instructions]` is answered by the brain with a `session.compaction`, and two of the
 * three outcomes are the reader's business: `nothing_to_summarize` and `failed`. Both carry the
 * brain's own sentence where it has one, and this draws it under the transcript with the other
 * notices — the clear, stored outcome the epic asks for, never a silent no-op.
 *
 * `summarized` draws nothing: the summary landed, and the "Conversation summarized" divider
 * above is the outcome. The words are the client's (`manualCompactionNotice`), so the web app
 * shows the same line for the same outcome.
 */
export function CompactionNotice({ compaction }: { compaction: TranscriptManualCompaction }) {
  const notice = manualCompactionNotice(compaction)
  if (notice === null) {
    return null
  }
  // Amber for a result that is merely explanatory, red for a failure — the palette's two
  // "look at this" tones (X4).
  return <Text color={notice.tone === 'error' ? 'red' : 'yellow'}>{notice.text}</Text>
}
