import { InMemorySkillStore } from '../memory'
import { runSkillStoreConformance } from './index'

/**
 * The acceptance test of the skill store contract (epic #349, K4): the suite runs against the
 * in-memory store, so everything it asserts is asserted by `yarn test` here — and the suite
 * itself is exercised end to end before the Postgres store meets it.
 */
runSkillStoreConformance((clock) => new InMemorySkillStore({ now: clock.now }), {
  name: 'InMemorySkillStore',
})
