import type { Client } from '@openharness/client'
import { useCallback, useSyncExternalStore } from 'react'

import { sessionRefresh, type SessionRefresh } from '../lib/session-refresh'

/** What a component needs from the store: the fresh copies, and how to ask for one. */
export type SessionRefreshes = Pick<SessionRefresh, 'sessions' | 'refresh'>

/**
 * The sessions re-read after their first message, and the way to ask for a re-read.
 *
 * Two components call this for the same client — the shell's `useSessions` and the open
 * chat's `useSession` — and `lib/session-refresh` hands both the same store, so the sidebar
 * row and the header change together off one request. See the module for why a title needs
 * one, and when it happens.
 */
export function useSessionRefresh(client: Client): SessionRefreshes {
  const store = sessionRefresh(client)
  const getSnapshot = useCallback(() => store.sessions, [store])
  const sessions = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)

  return { sessions, refresh: store.refresh }
}
