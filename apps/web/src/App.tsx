import { createClient, type Client } from '@openharness/client'
import { Menu } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ChatView } from './components/chat/chat-view'
import { ClientProvider, useClient } from './components/client-provider'
import { SIDEBAR_ID, Sidebar } from './components/sidebar'
import { Button } from './components/ui/button'
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

/**
 * The frame around every screen: the sidebar, and the routed screen.
 *
 * One sidebar, two layouts. From `md` up it is the static column it has always been; below
 * `md` the same panel is an overlay drawer, opened from the top bar that only exists at that
 * size. A phone-width chat therefore gets the whole viewport, and the list is one tap away
 * instead of occupying two thirds of the screen.
 */
function AppShell({ route, fakeClient }: { route: Route; fakeClient: boolean }) {
  const client = useClient()
  const { sessions, loading, error, truncated, create } = useSessions(client)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  const closeDrawer = useCallback((): void => {
    setDrawerOpen(false)
  }, [])

  // Going somewhere closes it: the drawer exists to pick a destination, and leaving it open
  // over the screen it just opened hides that screen on the size where it matters most.
  useEffect(() => {
    closeDrawer()
  }, [route])

  // Escape closes it, as it does for any overlay.
  useEffect(() => {
    if (!drawerOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeDrawer()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [drawerOpen])

  // Focus follows the drawer: into the panel when it opens, back to the button that opened it
  // when it closes — but never on the first render, which would steal focus from the page.
  useEffect(() => {
    if (drawerOpen) {
      panelRef.current?.focus()
    } else if (wasOpen.current) {
      menuButtonRef.current?.focus()
    }
    wasOpen.current = drawerOpen
  }, [drawerOpen])

  return (
    <>
      {drawerOpen ? (
        <div
          data-slot="sidebar-backdrop"
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={closeDrawer}
        />
      ) : null}

      <div className="flex h-full min-h-0">
        <Sidebar
          sessions={sessions}
          loading={loading}
          error={error}
          truncated={truncated}
          activeSessionId={route.name === 'chat' ? route.sessionId : undefined}
          fakeClient={fakeClient}
          open={drawerOpen}
          onNavigate={closeDrawer}
          panelRef={panelRef}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
            <Button
              ref={menuButtonRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Navigation"
              aria-expanded={drawerOpen}
              aria-controls={SIDEBAR_ID}
              onClick={() => {
                setDrawerOpen((current) => !current)
              }}
            >
              <Menu aria-hidden="true" />
            </Button>
            <span className="truncate text-sm font-medium">openharness</span>
          </div>

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
    </>
  )
}
