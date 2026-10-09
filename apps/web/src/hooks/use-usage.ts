import type { Client } from '@openharness/client'
import type { UserUsage } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { currentMonthRange } from '../lib/usage'
import { useSettings } from './use-settings'

/** What the Usage card reads: this month so far, by model and by day (epic #245, #247). */
export interface UsageView {
  /** The range, its zone, and what was spent in it. `null` until the first read answers. */
  readonly usage: UserUsage | null
  /** The first read is still in flight. */
  readonly loading: boolean
  /** A failed read, as shown inline. */
  readonly error: string | null
  /** Read the range again — what a Settings screen does after coming back to it. */
  readonly reload: () => Promise<void>
  /** Clear the error. */
  readonly dismissError: () => void
}

/**
 * The caller's own usage over the current month, in their own zone (epic #245, A2; issue #247).
 *
 * One read of `GET /v1/me/usage`, with the days and the zone the browser reports: the server
 * groups by **the reader's** local days, so the request has to carry the reader's zone rather
 * than the server's. The answer is not cached and nothing polls — usage is a screen a reader
 * opens, not a live figure to keep up with.
 *
 * A failed read is not fatal: the card shows the message and the rest of Settings works, which
 * is why the failure lands in {@link UsageView.error} rather than throwing.
 */
export function useUsage(client: Client): UsageView {
  const [usage, setUsage] = useState<UserUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { serverUrl } = useSettings()

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const response = await client.usage.me(
          currentMonthRange(),
          signal === undefined ? undefined : { signal },
        )
        if (signal?.aborted !== true) {
          setUsage(response)
          setError(null)
        }
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      }
    },
    [client, serverUrl],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [load])

  const reload = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { usage, loading, error, reload, dismissError }
}
