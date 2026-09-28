import type { Client } from '@openharness/client'
import { createContext, useContext, type ReactNode } from 'react'

const ClientContext = createContext<Client | null>(null)

/**
 * Hand the client to the tree.
 *
 * The client is a prop of `<App>` (a test passes the fake, `main.tsx` passes the real one),
 * so this context only exists to keep it from being threaded through every component.
 */
export function ClientProvider({ client, children }: { client: Client; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}

/** The client the app is talking to. */
export function useClient(): Client {
  const client = useContext(ClientContext)
  if (client === null) {
    throw new Error('useClient() was called outside <ClientProvider>.')
  }
  return client
}
