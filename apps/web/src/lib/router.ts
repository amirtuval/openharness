/**
 * The app's routes, as a hash.
 *
 * `#/s/<id>` rather than `/s/<id>` on purpose: the build is a static bundle that any static
 * host can serve, and a hash route needs no rewrite rule and no history fallback. The trade —
 * no server-side rendering of a route — costs nothing here.
 *
 * The device-approval page is the one route with a query
 * (`#/device?user_code=WXYZ-1234`): that is the URL `oh login` opens and the shape the
 * server's `verification_uri_complete` should take, so it has to survive a paste, a reload
 * and the sign-in round trip.
 *
 * Framework-free, like `settings.ts`: {@link parseRoute} is a pure function, the hook next to
 * it is the React binding.
 *
 * There is no `#/agents` route since #91: agents are hidden from the UI (they stay in the
 * API), so the screen and its route are gone and an old bookmark lands on the home screen.
 */

/** Where the app is. */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'new' }
  | { readonly name: 'chat'; readonly sessionId: string }
  | { readonly name: 'settings' }
  | { readonly name: 'signin'; readonly next: string | null }
  | { readonly name: 'device'; readonly userCode: string | null }

/** The route for a `location.hash`; anything unrecognized is the home screen. */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash
  const [pathname = '', search = ''] = path.split('?')
  const [first = '', second = ''] = pathname.split('/').filter((segment) => segment !== '')
  const query = new URLSearchParams(search)

  switch (first) {
    case '':
      return { name: 'home' }
    case 'new':
      return { name: 'new' }
    case 'settings':
      return { name: 'settings' }
    case 'signin':
      return { name: 'signin', next: emptyToNull(query.get('next')) }
    case 'device':
      return { name: 'device', userCode: emptyToNull(query.get('user_code')) }
    case 's':
      return second === '' ? { name: 'home' } : { name: 'chat', sessionId: decodeSegment(second) }
    default:
      return { name: 'home' }
  }
}

/** The hash for a route. */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'new':
      return '#/new'
    case 'settings':
      return '#/settings'
    case 'signin':
      return route.next === null ? '#/signin' : signInHash(route.next)
    case 'device':
      return deviceHash(route.userCode)
    case 'chat':
      return chatHash(route.sessionId)
  }
}

/** The chat route's hash, for links and for `navigate`. */
export function chatHash(sessionId: string): string {
  return `#/s/${encodeURIComponent(sessionId)}`
}

/** The settings route's hash, for links from the credential prompts. */
export function settingsHash(): string {
  return '#/settings'
}

/**
 * The sign-in route's hash, carrying where to go back to.
 *
 * Used by the prompts that ask for a fresh sign-in (the Model providers card, the missing-key
 * message in a chat): by the time the reader gets back, the route they were on is the one the
 * query names.
 */
export function signInHash(next: string): string {
  return `#/signin?next=${encodeURIComponent(next)}`
}

/**
 * The device-approval route's hash.
 *
 * The shape `oh login`'s verification URI takes: the server fills in `user_code`, and this
 * page hands the same string back to Better Auth's verify/approve/deny calls.
 */
export function deviceHash(userCode: string | null): string {
  return userCode === null ? '#/device' : `#/device?user_code=${encodeURIComponent(userCode)}`
}

/** Go somewhere. Assigning the hash pushes a history entry, so Back works. */
export function navigate(hash: string): void {
  window.location.hash = hash
}

/**
 * Read the current route.
 *
 * The parsed route is cached by hash: `useSyncExternalStore` compares snapshots by identity,
 * and re-parsing on every read would hand it a new object forever.
 */
export function currentRoute(): Route {
  const hash = window.location.hash
  if (hash !== cachedHash) {
    cachedHash = hash
    cachedRoute = parseRoute(hash)
  }
  return cachedRoute
}

/** Subscribe to hash changes. */
export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener('hashchange', listener)
  return () => {
    window.removeEventListener('hashchange', listener)
  }
}

let cachedHash: string | null = null
let cachedRoute: Route = { name: 'home' }

/** A percent-encoded path segment; an id that is not one is used as it is. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** A query value that is absent or empty, as `null`. */
function emptyToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value
}
