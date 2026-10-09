import { InMemorySessionStore } from '../memory'
import { runSessionStoreConformance } from './index'

/**
 * The acceptance test of this package: the conformance suite runs against the in-memory store.
 *
 * Everything the suite asserts is therefore asserted by `yarn test` here, and the suite is
 * exercised end to end — including the parts that only a later, asynchronous implementation
 * (the Postgres store) would otherwise reach first.
 */
runSessionStoreConformance((clock) => new InMemorySessionStore({ now: clock.now }), {
  name: 'InMemorySessionStore',
})
