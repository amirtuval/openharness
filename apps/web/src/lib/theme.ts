import { DEFAULT_USER_THEME, UserThemeSchema, type UserTheme } from '@openharness/protocol'

/**
 * The web app's theme (epic #201, X3): the choice, the `data-theme` attribute it resolves to,
 * and the cache that paints the first frame in the right colours.
 *
 * Three things meet here, and it is worth keeping them apart:
 *
 * - **The choice** is one of the protocol's four names — `system`, `light`, `dim`, `dark` —
 *   and it is what the settings screen and the sidebar's quick switch show. It is stored on
 *   the server (`GET`/`PUT /v1/me/preferences`), so it follows the user to another browser.
 * - **The resolved theme** is always a concrete `light`, `dim` or `dark`: `system` is resolved
 *   here against `prefers-color-scheme`, and re-resolved whenever the operating system
 *   changes, which is what "System" means. Only the resolved name reaches the DOM.
 * - **The cache** is the one string this app writes to `localStorage`, read by the inline
 *   script in `index.html` *before* the first paint, so a dark-theme reader never sees a white
 *   flash. {@link adoptTheme} refreshes it whenever the server's value arrives.
 *
 * The store is framework-free and shaped like `lib/settings.ts`, down to the
 * `useSyncExternalStore`-friendly stable snapshot, so the sidebar and the settings screen read
 * one value and neither owns the other. The write back to the server is *not* here: it is
 * `components/theme-preference.tsx`, the one place that knows about the client.
 */

/** The `localStorage` key holding the cached choice. Read by `index.html`'s inline script. */
export const THEME_STORAGE_KEY = 'openharness:theme'

/** What a themed page's `data-theme` is set to: never `system`, always one of the three. */
export type ResolvedTheme = 'light' | 'dim' | 'dark'

/** The choice a reader who has never picked one has: follow the operating system. */
export const DEFAULT_THEME = DEFAULT_USER_THEME

/**
 * The four choices, in the order the pickers show them.
 *
 * `system` first because it is the default and the one most people want; the three explicit
 * themes after it, lightest to darkest.
 */
export const THEME_OPTIONS: readonly { readonly value: UserTheme; readonly label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dim', label: 'Dim' },
  { value: 'dark', label: 'Dark' },
]

const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

const listeners = new Set<() => void>()
let watching = false

/** The `MediaQueryList` this module already listens on, so it listens once per list. */
let watchedQuery: MediaQueryList | undefined = undefined

/** The choice in effect, as the pickers show it. Kept in step with the cache, not the server. */
let snapshot: UserTheme = DEFAULT_THEME

/** The cache as the last read saw it, so an unchanged one is not re-applied. */
let sawCache: string | null | undefined = undefined

/**
 * The choice in effect: `system`, `light`, `dim` or `dark`.
 *
 * A string, so it is a stable snapshot for `useSyncExternalStore`. Reading it also picks up a
 * cache another tab (or a test's cleanup) changed underneath us, which is what keeps the DOM
 * attribute and the choice from drifting apart.
 */
export function getTheme(): UserTheme {
  readCache()
  return snapshot
}

/** Watch for changes, from this tab or another one. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  if (!watching) {
    watching = true
    window.addEventListener('storage', onStorage)
  }
  watchSystemTheme()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Apply a theme the reader just picked: resolve it, paint it, cache it and tell the tree.
 *
 * Instant by construction — the click never waits for the server — which is why the write
 * back is a separate concern (`components/theme-preference.tsx`).
 */
export function chooseTheme(next: UserTheme): void {
  apply(next)
}

/**
 * Apply the theme the account has stored, and refresh the cache.
 *
 * Unconditional, and deliberately so: this store does not know which server read is current,
 * and "the account's value must not undo a click that has not been saved yet" is a question
 * about *a request in flight*, which only the caller that made it can answer — see
 * `components/theme-preference.tsx`, which is the one caller.
 */
export function adoptTheme(next: UserTheme): void {
  apply(next)
}

/** The theme a choice resolves to, given the operating system's preference. */
export function resolveTheme(next: UserTheme, prefersDark: boolean): ResolvedTheme {
  if (next !== 'system') {
    return next
  }
  return prefersDark ? 'dark' : 'light'
}

/**
 * Paint a choice: resolve it, set `data-theme` on `<html>`, write the cache.
 *
 * The attribute is the only thing the stylesheet reads — one block of CSS variables per theme
 * — and it is set on `<html>` because `@custom-variant dark` in `index.css` matches
 * `[data-theme='dark']` and `[data-theme='dim']` there and on everything below it.
 */
function apply(next: UserTheme): void {
  snapshot = next
  document.documentElement.dataset.theme = resolveTheme(next, prefersDark())
  sawCache = writeCache(next)
  notify()
}

/** Take the cache's value if it changed since the last read, and skip the write back to it. */
function readCache(): void {
  const raw = readRaw()
  if (raw === sawCache) {
    return
  }
  sawCache = raw
  const parsed = UserThemeSchema.safeParse(raw)
  const next = parsed.success ? parsed.data : DEFAULT_THEME
  if (next === snapshot) {
    return
  }
  snapshot = next
  document.documentElement.dataset.theme = resolveTheme(next, prefersDark())
}

/**
 * Listen for the operating system's preference changing.
 *
 * Attached to the `MediaQueryList` itself rather than behind a flag, and only once per list: a
 * browser answers the same object for the same query, so this is the one listener the page
 * needs, while a test that stubs `matchMedia` with a fresh object each call gets a listener on
 * each of them and every one of them fires.
 */
function watchSystemTheme(): void {
  const query = mediaQuery()
  if (query === undefined || query === watchedQuery) {
    return
  }
  watchedQuery = query
  query.addEventListener('change', onSystemThemeChanged)
}

/**
 * The operating system flipped: repaint, if `system` is the choice.
 *
 * Nothing is stored or announced — the choice has not changed, only what it resolves to — so
 * this is deliberately not an {@link apply}: no cache write and no notify, just the attribute
 * the stylesheet reads.
 */
function onSystemThemeChanged(): void {
  if (snapshot === 'system') {
    document.documentElement.dataset.theme = resolveTheme('system', prefersDark())
  }
}

/** Another tab changed the theme: take its cache as the choice, on the next render. */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== THEME_STORAGE_KEY) {
    return
  }
  const parsed = UserThemeSchema.safeParse(readRaw())
  adoptTheme(parsed.success ? parsed.data : DEFAULT_THEME)
}

/**
 * The operating system's preference, or `false` where there is no `matchMedia`.
 *
 * jsdom does not implement `matchMedia` at all, and neither does any environment that is not a
 * browser; a missing one is read as "not dark", which is what the `:root` token block renders
 * anyway.
 */
function prefersDark(): boolean {
  return mediaQuery()?.matches ?? false
}

/**
 * `matchMedia`'s answer for the system preference, or `undefined` where there is none.
 *
 * Asked for on every use rather than kept: a browser answers the same object for the same
 * query, and a test that stubs `matchMedia` (which every one that cares about `system` does)
 * would otherwise hand the module a stale one.
 */
function mediaQuery(): MediaQueryList | undefined {
  if (typeof window.matchMedia !== 'function') {
    return undefined
  }
  return window.matchMedia(SYSTEM_QUERY)
}

/** The stored cache: `null` when nothing is saved, `undefined` when storage cannot be read. */
function readRaw(): string | null | undefined {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    return undefined
  }
}

/** Cache a choice for the next first paint, and answer what the cache now holds. */
function writeCache(next: UserTheme): string | null {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next)
    return next
  } catch {
    // Storage that refuses the write costs a flash on the next load, nothing more.
    return null
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Paint once at import: `index.html`'s inline script has already done this from the cache, and
// doing it again is idempotent — but a test that imports the module without that script (all
// of them) still starts on the cached theme.
readCache()
document.documentElement.dataset.theme = resolveTheme(snapshot, prefersDark())
