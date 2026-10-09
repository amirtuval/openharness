/**
 * Freezing the log at runtime (D9, issue #46).
 *
 * "No stored event is ever modified" is enforced three ways: by the types (`Immutable*`), by
 * the contract (no store method modifies an event), and by this — the objects a store keeps
 * and hands out are `Object.freeze`d recursively, so a mutation that slipped past the types
 * throws instead of silently forking the log a reader holds from the log the store wrote.
 *
 * The fake does this to its own state and to its answers; `PostgresSessionStore` freezes the
 * events it builds from rows, so a test mutating a returned event fails the same way against
 * either store — which is what lets the conformance suite ask for it. Sessions, agents and
 * leases are not events and are not frozen: they are mutable resources, and a store hands out
 * copies of them.
 */

/**
 * `value`, with every object inside it — arrays included — frozen.
 *
 * Frozen trees stay frozen under reading, and a copy of one (`structuredClone`, a spread) is
 * not frozen: each hand-out freezes its own copy, so a caller's view can never become another
 * caller's. Primitives pass through.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value
  }
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return value
}
