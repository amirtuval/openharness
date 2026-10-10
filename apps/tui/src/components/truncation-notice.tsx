import type { TranscriptTruncation } from '@openharness/client'
import { Text } from 'ink'

/**
 * "your message was too long for this model and was shortened" (epic #277, K6/K10; #280).
 *
 * The one compaction fact about the reader's own message rather than about the model's
 * bookkeeping: the newest message alone was over the chat model's budget, so the request carried
 * it capped to a head and a tail around an omission marker. The transcript still shows the whole
 * message — nothing is edited — which is why this line has to exist: what the reader typed and
 * what the model was sent are not the same text.
 *
 * It sits under the transcript, where the notices do, and it says how much was left out: a
 * terminal has no tooltip, so a number that only existed on hover would not exist here. It is
 * drawn from the **newest** request's record, so a later request that capped nothing clears it.
 */
export function TruncationNotice({ truncation }: { truncation: TranscriptTruncation }) {
  // Amber, the palette's "something to look at": a shortened message arrived, which is not a
  // failure and not the reader's error either (X4).
  return <Text color="yellow">{truncationLine(truncation)}</Text>
}

/**
 * The line itself, without a terminal — the words are the whole of it, and a frame test reads
 * them from here rather than through a render.
 */
export function truncationLine(truncation: TranscriptTruncation): string {
  const omitted = Math.max(0, truncation.tokensBefore - truncation.tokensAfter)
  return `your message was too long for this model and was shortened (about ${String(
    omitted,
  )} tokens left out)`
}
