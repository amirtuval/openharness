import { createClient, type Client } from '@openharness/client'
import type { User } from '@openharness/protocol'
import { Menu } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AuthProvider, useBrowserAuth } from './components/auth-provider'
import { ChatView } from './components/chat/chat-view'
import { ClientProvider, useClient } from './components/client-provider'
import { SIDEBAR_ID, Sidebar } from './components/sidebar'
import { Button } from './components/ui/button'
import { useAuthState } from './hooks/use-auth'
import { useModels } from './hooks/use-models'
import { useRoute } from './hooks/use-route'
import { useSessions } from './hooks/use-sessions'
import { useSettings } from './hooks/use-settings'
import { createBrowserAuthClient } from './lib/auth-client'
import { beginSessionCheck, signOutSession } from './lib/auth-store'
import { modelNameLookup } from './lib/models'
import { navigate, routeToHash, type Route } from './lib/router'
import { DeviceScreen } from './screens/device-screen'
import { HomeScreen } from './screens/home-screen'
import { NewChatScreen } from './screens/new-chat-screen'
import { SettingsScreen } from './screens/settings-screen'
import { SignInScreen } from './screens/sign-in-screen'

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
 * The app: one client, one auth client, one route, a sidebar and a screen.
 *
 * The client is built here, from the saved settings — which is also why saving the settings
 * screen changes the server immediately: the settings store notifies, this component
 * re-renders, and the client is rebuilt. An empty server URL means the page's own origin.
 * The Better Auth client is built from the same setting, because sign-in and the API have to
 * be the same server.
 */
export function App({ client: providedClient, fakeClient = false }: AppProps = {}) {
  const settings = useSettings()
  const client = useMemo(
    () => providedClient ?? createClient({ baseUrl: settings.serverUrl }),
    [providedClient, settings.serverUrl],
  )
  const auth = useMemo(() => createBrowserAuthClient(settings.serverUrl), [settings.serverUrl])

  const route = useRoute()

  return (
    <ClientProvider client={client}>
      <AuthProvider auth={auth}>
        <AppShell route={route} fakeClient={fakeClient} />
      </AuthProvider>
    </ClientProvider>
  )
}

/**
 * The authentication gate, and then the app.
 *
 * The session is a cookie the app cannot read (epic #65, A2), so the first thing that happens
 * is `client.me()` — and until it answers there is nothing to show. A 401, from that read or
 * from any later call (which is what `noteAuthenticationError` is for), puts the sign-in page
 * in place of everything else, and signing in puts the reader back on the route they were on,
 * which never moved.
 *
 * Nothing behind the gate is even mounted while it is shut: a signed-out browser has no
 * sidebar and no lists to load, because every one of them would answer 401. The device
 * approval page is the one route that is *reached* without a session, and the sign-in page is
 * what it renders — verifying a device code claims it for the signed-in session (A6), so
 * there is no approving anything before signing in.
 */
function AppShell({ route, fakeClient }: { route: Route; fakeClient: boolean }) {
  const client = useClient()
  const auth = useBrowserAuth()
  const authState = useAuthState(client)

  // Who the app is signed in as: the one read per client, and the reason a 401 from anywhere
  // lands on the sign-in page.
  useEffect(() => {
    void beginSessionCheck(client)
  }, [client])

  // The last client whose check answered "signed in", and the user it answered with.
  //
  // A settings save rebuilds the client (the `useMemo` in `App`), and the effect above re-runs
  // for the new one — which is right, because another server means another session. What must
  // not happen is the screen being *torn down* while that re-check runs: Settings keeps its
  // "Saved" confirmation in local state, and the "Checking your session…" branch below would
  // unmount it in the same tick it is set (issue #81). So a re-check on a rebuilt client keeps
  // the frame up with the previous user until the new client has answered — a signed-out
  // answer still puts the sign-in page in place, and the first check of all has nothing to
  // keep and shows the checking screen, as before.
  const lastSignedIn = useRef<{ client: Client; user: User } | null>(null)
  useEffect(() => {
    if (authState.status === 'signed-in') {
      lastSignedIn.current = { client, user: authState.user }
    }
  }, [authState, client])

  const onSignOut = useCallback((): void => {
    void signOutSession(client, auth)
  }, [client, auth])

  // Signed in *and* on the sign-in page — the reader followed a `#/signin` link, or the
  // server sent them back there after a social sign-in. Where they meant to go is in the
  // route; without one, home.
  useEffect(() => {
    if (authState.status === 'signed-in' && route.name === 'signin') {
      navigate(route.next ?? '#/')
    }
  }, [authState.status, route])

  if (authState.status === 'checking') {
    const previous = lastSignedIn.current
    if (previous === null || previous.client === client) {
      return (
        <CenteredScreen>
          <p role="status" className="text-sm text-muted-foreground">
            Checking your session…
          </p>
        </CenteredScreen>
      )
    }
    // The client was rebuilt under a signed-in app: a re-check, not a cold start (issue #81).
    return (
      <AppFrame route={route} fakeClient={fakeClient} user={previous.user} onSignOut={onSignOut} />
    )
  }

  if (authState.status === 'signed-out') {
    // The screen centres itself; there is nothing beside it.
    return <SignInScreen returnHash={signInReturnHash(route)} />
  }

  return (
    <AppFrame route={route} fakeClient={fakeClient} user={authState.user} onSignOut={onSignOut} />
  )
}

/**
 * The signed-in frame: one sidebar, two layouts.
 *
 * From `md` up it is the static column it has always been; below `md` the same panel is an
 * overlay drawer, opened from the top bar that only exists at that size. A phone-width chat
 * therefore gets the whole viewport, and the list is one tap away instead of occupying two
 * thirds of the screen.
 */
function AppFrame({
  route,
  fakeClient,
  user,
  onSignOut,
}: {
  route: Route
  fakeClient: boolean
  user: User
  onSignOut: () => void
}) {
  const client = useClient()
  const { sessions, loading, error, truncated, create } = useSessions(client)
  // The catalog is loaded once here, for the whole shell: the New chat picker offers it, and
  // the sidebar and the chat header label untitled sessions with its display names (#91).
  const catalog = useModels(client)
  const nameOf = useMemo(() => modelNameLookup(catalog.models), [catalog.models])

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
  }, [route, closeDrawer])

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
  }, [drawerOpen, closeDrawer])

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
          user={user}
          onSignOut={onSignOut}
          fakeClient={fakeClient}
          open={drawerOpen}
          onNavigate={closeDrawer}
          panelRef={panelRef}
          nameOf={nameOf}
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
            <ChatView key={route.sessionId} sessionId={route.sessionId} nameOf={nameOf} />
          ) : route.name === 'new' ? (
            <NewChatScreen createSession={create} catalog={catalog} />
          ) : route.name === 'settings' ? (
            <SettingsScreen />
          ) : route.name === 'device' ? (
            <DeviceScreen userCode={route.userCode} />
          ) : route.name === 'signin' ? (
            // Signed in: the effect above is already moving the hash on; this is what the
            // screen shows for the frame or two that takes.
            <SignInScreen returnHash={signInReturnHash(route)} />
          ) : (
            <HomeScreen />
          )}
        </main>
      </div>
    </>
  )
}

/** A screen with nothing else around it: the sign-in page, and the session check before it. */
function CenteredScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 items-center justify-center px-6">{children}</div>
}

/**
 * Where signing in should return to.
 *
 * A `#/signin` route may carry one (`?next=`); anywhere else, the route the reader is on *is*
 * the place to come back to — and for a social sign-in that travels to the provider, the hash
 * is what the browser returns to (the page is a SPA, so the URL is the state).
 */
function signInReturnHash(route: Route): string {
  if (route.name === 'signin') {
    return route.next ?? '#/'
  }
  const hash = window.location.hash
  return hash === '' ? routeToHash(route) : hash
}
