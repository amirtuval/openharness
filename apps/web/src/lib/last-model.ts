/**
 * The model the reader used last, remembered across visits (issue #91).
 *
 * One string in `localStorage`, so a New chat screen opens on the model that was chosen last
 * time instead of an arbitrary first entry — the web app's equivalent of `oh`'s remembered
 * model. Guarded with `try`/`catch` like `settings.ts`: a storage that throws (private mode,
 * a sandboxed frame, no `localStorage` at all) means the picker simply has no default, never
 * that a screen fails to render.
 */

/** The storage key. Namespaced like the settings store's. */
const STORAGE_KEY = 'openharness:last-model'

/** The remembered model id, or `null` when there is none (or storage is not usable). */
export function readLastModel(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === null || stored.trim() === '' ? null : stored
  } catch {
    return null
  }
}

/** Remember the model a chat was just created with, for the next New chat. */
export function rememberLastModel(modelId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, modelId)
  } catch {
    // The picker just has no default next time; nothing else depends on this.
  }
}
