/**
 * The `provider/model` shape a Mastra router id has (issue #94; epic #116, U1/U3).
 *
 * The protocol's `ModelConfigSchema` deliberately does not pin the format — the router accepts
 * models the catalogue does not know yet (C5), and a free-text id is allowed — so the routes
 * that take an id from a request are what refuse one no provider could ever resolve. It is a
 * shape check, never a catalogue lookup.
 */
export function isRouterModelId(id: string): boolean {
  const parts = id.split('/')
  return parts.length >= 2 && parts.every((part) => part.length > 0)
}
