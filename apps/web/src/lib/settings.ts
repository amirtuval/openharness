/**
 * The app's settings: where the server is. That is all it is.
 *
 * One string in `localStorage`, and a tiny store around it so React can read it with
 * `useSyncExternalStore`. Framework-free on purpose: the settings screen and the app root
 * both need to see a save, and neither owns the other.
 *
 * An **empty server URL means "same origin"**: the client is built with a relative base URL,
 * so the page's own origin serves `/v1`. That is the right default behind the Vite dev proxy
 * and for a static build served next to the API.
 *
 * There used to be a second field — the static `x-api-key` — and it is gone (epic #65, A8):
 * authentication is the session cookie now (a browser) or a bearer token (the CLI), and no
 * browser-side key exists to store. A blob left by an older version is dropped the first time
 * the settings are read, so nothing keeps carrying it around.
 */

/** What the settings screen edits and the client is built from. */
export interface Settings {
  /** Server root, e.g. `http://localhost:3000`. Empty means same origin. */
  serverUrl: string
}

/** The `localStorage` key. Namespaced, and the only one this app writes. */
export const SETTINGS_STORAGE_KEY = 'openharness:settings'

/** Settings for a browser that has never saved any. */
export const DEFAULT_SETTINGS: Settings = { serverUrl: '' }

/** Settings as an older version of this app stored them — read, then dropped. */
interface LegacySettings {
  apiKey?: unknown
}

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
    const parsed = parseSettings(raw)
    cachedRaw = parsed.migratedRaw ?? raw
    snapshot = parsed.settings
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

/**
 * Parse a stored value, with anything unreadable falling back to the defaults.
 *
 * A value that still carries the removed `apiKey` field comes back with `migratedRaw` set:
 * the caller keeps the cleaned string as what it has read, and writes it back so the key is
 * not left sitting in the browser (A8).
 */
function parseSettings(raw: string | null): { settings: Settings; migratedRaw?: string } {
  const fallback = { settings: DEFAULT_SETTINGS }
  if (raw === null) {
    return fallback
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A corrupted value: defaults beat a broken app.
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fallback
  }
  const record = parsed as Record<string, unknown> & LegacySettings
  const settings: Settings = {
    serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl : '',
  }
  if (record.apiKey === undefined) {
    return { settings }
  }
  const cleaned = JSON.stringify(settings)
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, cleaned)
  } catch {
    // Storage that refuses the cleanup still gets the clean settings in memory.
  }
  return { settings, migratedRaw: cleaned }
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
