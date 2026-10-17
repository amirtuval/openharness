import type { Client } from '@openharness/client'
import type { DescendantUsage } from '@openharness/protocol'
import { useEffect, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'

/**
 * What a chat's **descendants** spent (epic #340, S8; issue #346).
 *
 * A subagent is a real session with its own log, so its requests are billed to it — but a chat
 * that delegates work should not look cheap, which is why `GET /v1/sessions/{id}/usage` covers the
 * whole tree and carries the descendants' own share beside it. The chat's transcript cannot
 * answer that: a `session.usage` event is the *session's* own totals, and the child's are in the
 * child's log. So the header reads the route, and this hook is the read.
 *
 * **Only a chat that has a task is asked.** A chat with no child has nothing to say about
 * descendants (the route would answer zeroes), and a request per open chat is a request nobody
 * needed. The read is keyed by `signature` — what the caller can see of its tasks — so the numbers
 * move when the chat learns something new about a helper (a status moving, a result landing),
 * which is exactly when the descendants' totals can have changed as far as this chat can tell.
 *
 * A failed read answers `null` and says nothing: this is the header's garnish, and a banner over
 * somebody's conversation for it would be worse than the missing number.
 *
 * @param client the app's client
 * @param sessionId the open session
 * @param options `enabled` — whether this chat has a task at all — and the signature to re-read on
 */
export function useSubtreeUsage(
  client: Client,
  sessionId: string,
  options: { readonly enabled: boolean; readonly signature: string },
): DescendantUsage | null {
  const [usage, setUsage] = useState<DescendantUsage | null>(null)
  const { enabled, signature } = options

  useEffect(() => {
    if (!enabled) {
      setUsage(null)
      return
    }
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      try {
        const answer = await client.usage.session(sessionId, { signal: controller.signal })
        if (!controller.signal.aborted) {
          setUsage(answer.descendants)
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          noteAuthenticationError(client, caught)
          setUsage(null)
        }
      }
    }
    void read()
    return () => controller.abort()
  }, [client, sessionId, enabled, signature])

  return usage
}
