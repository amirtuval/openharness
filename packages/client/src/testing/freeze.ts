/**
 * Freezing the events a fake hands out.
 *
 * The session log is append-only (D9): an event, once written, never changes. The real store
 * says so with deep-readonly types and deep-frozen events; the fakes say so the same way, so a
 * consumer that tries to rewrite an event fails in a test instead of in production. A frozen
 * event also makes the transcript's purity checkable at runtime: folding a frozen event that
 * the reducer tried to modify throws a `TypeError` in strict mode rather than passing silently.
 */

/**
 * `value`, with every object and array inside it frozen, in place.
 *
 * Cyclic values are fine — a frozen node is skipped — and a value that is already deep-frozen
 * costs one `Object.isFrozen` per node. Primitives pass through.
 *
 * @param value the value to freeze, mutated in place
 * @returns the same value, typed as before
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}
