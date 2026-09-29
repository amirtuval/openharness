import { createClient, type Client } from '@openharness/client'
import { useMemo } from 'react'

import { ChatView } from './components/chat/chat-view'
import { ClientProvider, useClient } from './components/client-provider'
import { Sidebar } from './components/sidebar'
import { useRoute } from './hooks/use-route'
import { useSessions } from './hooks/use-sessions'
import { useSettings } from './hooks/use-settings'
import type { Route } from './lib/router'
import { AgentsScreen } from './screens/agents-screen'
import { HomeScreen } from './screens/home-screen'
import { NewChatScreen } from './screens/new-chat-screen'
import { SettingsScreen } from './screens/settings-screen'

/** What the root takes. `client` is the seam every test uses. */
export interface AppProps {
  /**
   * The client to use. `main.tsx` passes the dev fake client in fake mode; a test passes
   * `createFakeClient()`. Omitted, the app builds the real one from the saved settings.
   */
  client?: Client | undefined
  /** Show that this run is on the fake client, not a server. */
  fakeClient?: boolean | undefined
}

/**
 * The app: one client, one route, a sidebar and a screen.
 *
 * The client is built here, from the saved settings — which is also why saving the settings
 * screen changes the server immediately: the settings store notifies, this component
 * re-renders, and the client is rebuilt. An empty server URL means the page's own origin.
 */
export function App({ client: providedClient, fakeClient = false }: AppProps = {}) {
  const settings = useSettings()
  const client = useMemo(
    () =>
      providedClient ??
      createClient({
        baseUrl: settings.serverUrl,
        apiKey: settings.apiKey === '' ? undefined : settings.apiKey,
      }),
    [providedClient, settings.serverUrl, settings.apiKey],
  )

  const route = useRoute()

  return (
    <ClientProvider client={client}>
      <AppShell route={route} fakeClient={fakeClient} />
    </ClientProvider>
  )
}

/** The frame around every screen: the sidebar, and the routed screen. */
function AppShell({ route, fakeClient }: { route: Route; fakeClient: boolean }) {
  const client = useClient()
  const { sessions, loading, error, truncated, create } = useSessions(client)

  return (
    <div className="flex h-full min-h-0">
      <Sidebar
        sessions={sessions}
        loading={loading}
        error={error}
        truncated={truncated}
        activeSessionId={route.name === 'chat' ? route.sessionId : undefined}
        fakeClient={fakeClient}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {route.name === 'chat' ? (
          // Keyed by session: opening another chat mounts a fresh transcript and stream
          // rather than mutating one in place.
          <ChatView key={route.sessionId} sessionId={route.sessionId} />
        ) : route.name === 'new' ? (
          <NewChatScreen createSession={create} />
        ) : route.name === 'agents' ? (
          <AgentsScreen />
        ) : route.name === 'settings' ? (
          <SettingsScreen />
        ) : (
          <HomeScreen />
        )}
      </main>
    </div>
  )
}
