import type { Client } from '@openharness/client'
import { useSyncExternalStore } from 'react'

import { authStateFor, subscribeAuth, type AuthState } from '../lib/auth-store'

/** The signed-in state of one client, re-rendering the caller when it changes. */
export function useAuthState(client: Client): AuthState {
  const getSnapshot = (): AuthState => authStateFor(client)
  return useSyncExternalStore(subscribeAuth, getSnapshot, getSnapshot)
}
