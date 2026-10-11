import { InMemoryMcpServerStore } from '../memory'
import { runMcpServerStoreConformance } from './index'

/**
 * The acceptance test of the MCP server store contract (epic #303, X10): the suite runs against
 * the in-memory store, so everything it asserts is asserted by `yarn test` here — and the suite
 * itself is exercised end to end before the Postgres store meets it.
 */
runMcpServerStoreConformance((clock) => new InMemoryMcpServerStore({ now: clock.now }), {
  name: 'InMemoryMcpServerStore',
})
