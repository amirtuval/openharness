/**
 * The app's routes, as a hash.
 *
 * `#/s/<id>` rather than `/s/<id>` on purpose: the build is a static bundle that any static
 * host can serve, and a hash route needs no rewrite rule and no history fallback. The trade —
 * no server-side rendering of a route — costs nothing here.
 *
 * Framework-free, like `settings.ts`: {@link parseRoute} is a pure function, the hook next to
 * it is the React binding.
 */

/** Where the app is. */
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'new' }
  | { readonly name: 'chat'; readonly sessionId: string }
  | { readonly name: 'agents' }
  | { readonly name: 'settings' }

/** The route for a `location.hash`; anything unrecognized is the home screen. */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash
  const [first = '', second = ''] = path.split('/').filter((segment) => segment !== '')

  switch (first) {
    case '':
      return { name: 'home' }
    case 'new':
      return { name: 'new' }
    case 'agents':
      return { name: 'agents' }
    case 'settings':
      return { name: 'settings' }
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
    case 'agents':
      return '#/agents'
    case 'settings':
      return '#/settings'
    case 'chat':
      return `#/s/${encodeURIComponent(route.sessionId)}`
  }
}

/** The chat route's hash, for links and for `navigate`. */
export function chatHash(sessionId: string): string {
  return routeToHash({ name: 'chat', sessionId })
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
