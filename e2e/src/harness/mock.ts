import { MOCK_SLOW_CHUNKS } from '@openharness/server'

/**
 * What the server's deterministic test model replies to a `__slow__` prompt.
 *
 * The server exports the *shape* of the mock (`MOCK_SLOW_CHUNKS`, `MOCK_MODEL_USAGE`, the
 * markers), not every string it produces, and this is a test-side restatement of the one
 * string e2e assertions compare against: a `__slow__` reply is one numbered part per chunk,
 * which is what makes "the interrupt kept a strict prefix of the reply" a checkable claim.
 */
export function expectedSlowReply(): string {
  return Array.from(
    { length: MOCK_SLOW_CHUNKS },
    (_, index) => `part ${String(index + 1)}/${String(MOCK_SLOW_CHUNKS)}`,
  ).join(' ')
}
