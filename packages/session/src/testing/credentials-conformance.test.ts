import { InMemoryCredentialStore } from '../memory'
import { runCredentialStoreConformance } from './index'

/**
 * The acceptance test of the credential store contract: the suite runs against the in-memory
 * store, so everything it asserts is asserted by `yarn test` here — and the suite itself is
 * exercised end to end before the Postgres store meets it.
 */
runCredentialStoreConformance((clock) => new InMemoryCredentialStore({ now: clock.now }), {
  name: 'InMemoryCredentialStore',
})
