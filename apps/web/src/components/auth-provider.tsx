import { createContext, useContext, type ReactNode } from 'react'

import type { BrowserAuthClient } from '../lib/auth-client'

const AuthClientContext = createContext<BrowserAuthClient | null>(null)

/**
 * Hand the browser's Better Auth client to the tree.
 *
 * It is built in `<App>` from the same settings as the API client — the sign-in endpoints and
 * the API have to be the same server — and this context keeps it from being threaded through
 * every screen.
 */
export function AuthProvider({ auth, children }: { auth: BrowserAuthClient; children: ReactNode }) {
  return <AuthClientContext.Provider value={auth}>{children}</AuthClientContext.Provider>
}

/** The browser's auth client: sign-in, sign-out and device approval. */
export function useBrowserAuth(): BrowserAuthClient {
  const auth = useContext(AuthClientContext)
  if (auth === null) {
    throw new Error('useBrowserAuth() was called outside <AuthProvider>.')
  }
  return auth
}
