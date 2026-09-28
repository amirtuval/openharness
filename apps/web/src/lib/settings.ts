/**
 * The app's settings: where the server is and how to authenticate to it.
 *
 * Two strings in `localStorage`, and a tiny store around them so React can read them with
 * `useSyncExternalStore`. Framework-free on purpose: the settings screen and the app root
 * both need to see a save, and neither owns the other.
 *
 * An **empty server URL means "same origin"**: the client is built with a relative base URL,
 * so the page's own origin serves `/v1`. That is the right default behind the Vite dev proxy
 * and for a static build served next to the API.
 */

/** What the settings screen edits and the client is built from. */
export interface Settings {
  /** Server root, e.g. `http://localhost:3000`. Empty means same origin. */
  serverUrl: string
  /** Value of the `x-api-key` header. Empty means the server needs no auth. */
  apiKey: string
}

/** The `localStorage` key. Namespaced, and the only one this app writes. */
export const SETTINGS_STORAGE_KEY = 'openharness:settings'

/** Settings for a browser that has never saved any. */
export const DEFAULT_SETTINGS: Settings = { serverUrl: '', apiKey: '' }

const listeners = new Set<() => void>()
let cachedRaw: string | null | undefined
let snapshot: Settings = DEFAULT_SETTINGS
let listening = false

/**
 * The current settings.
 *
 * The returned object is stable while `localStorage` does not change — `useSyncExternalStore`
 * compares snapshots by identity — and reading is one `getItem` and a string comparison, so
 * another tab's save is picked up the next time this is called.
 */
export function getSettings(): Settings {
  const raw = readRaw()
  if (raw === undefined) {
    // The storage cannot be read at all (a browser with cookies off, a sandboxed frame):
    // keep what this tab has, rather than pretending nothing was ever saved.
    return snapshot
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    snapshot = parseSettings(raw)
  }
  return snapshot
}

/** Replace the settings and notify subscribers. Fields left out keep their value. */
export function saveSettings(next: Partial<Settings>): Settings {
  const merged = { ...getSettings(), ...next }
  const raw = JSON.stringify(merged)
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, raw)
  } catch {
    // A browser that refuses to store them still gets a working app.
  }
  cachedRaw = raw
  snapshot = merged
  notify()
  return merged
}

/** Forget the saved settings, back to the defaults. */
export function resetSettings(): Settings {
  return saveSettings(DEFAULT_SETTINGS)
}

/** Watch for changes, from this tab or another one. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  if (!listening) {
    listening = true
    window.addEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The stored value: `null` when nothing was saved, `undefined` when the storage cannot be
 * read at all — the two are not the same, and only one of them means "start over".
 */
function readRaw(): string | null | undefined {
  try {
    return localStorage.getItem(SETTINGS_STORAGE_KEY)
  } catch {
    return undefined
  }
}

/** Parse a stored value, with anything unreadable falling back to the defaults. */
function parseSettings(raw: string | null): Settings {
  if (raw === null) {
    return DEFAULT_SETTINGS
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_SETTINGS
    }
    const record = parsed as Record<string, unknown>
    return {
      serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl : '',
      apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    }
  } catch {
    // A corrupted value: defaults beat a broken app.
    return DEFAULT_SETTINGS
  }
}

/** Another tab changed the settings; let the store re-read them on the next render. */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== SETTINGS_STORAGE_KEY) {
    return
  }
  notify()
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}
