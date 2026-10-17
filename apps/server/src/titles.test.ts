import { describe, expect, it } from 'vitest'
import { EVENT_TYPES } from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'

import { TEST_OWNER_ID } from './test-support'
import { nameSessionFromFirstMessage } from './titles'

/**
 * Naming a session after its first message: the write path, and the one rule it has to keep —
 * a title that exists is never replaced.
 *
 * The derivation itself is the protocol's, asserted there (`@openharness/protocol`'s
 * `titles.test.ts`) since the brain names a child session with the same rule (epic #340).
 */

/** A `user.message` as a client sends it. */
function userMessage(text: string): {
  type: 'user.message'
  content: { type: 'text'; text: string }[]
} {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** A store with one agent and one session, and an empty log. */
async function storeWithSession() {
  const store = new InMemorySessionStore()
  const agent = await store.createAgent(
    { name: 'Agent', model: { id: 'test/model' } },
    TEST_OWNER_ID,
  )
  const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
  return { store, session }
}

describe('nameSessionFromFirstMessage', () => {
  it('names a session after the first message of a batch', async () => {
    const { store, session } = await storeWithSession()

    const named = await nameSessionFromFirstMessage(
      store,
      session.id,
      [{ type: EVENT_TYPES.userInterrupt }, userMessage('Tell me about the session log')],
      TEST_OWNER_ID,
    )

    expect(named?.title).toBe('Tell me about the session log')
    expect((await store.getSession(session.id, { ownerId: TEST_OWNER_ID }))?.title).toBe(
      'Tell me about the session log',
    )
  })

  it('leaves a title that already exists alone', async () => {
    const { store, session } = await storeWithSession()
    await store.updateSession(session.id, { title: 'Chosen already' })

    const named = await nameSessionFromFirstMessage(
      store,
      session.id,
      [userMessage('a message that would have named it otherwise')],
      TEST_OWNER_ID,
    )

    expect(named).toBeNull()
    expect((await store.getSession(session.id, { ownerId: TEST_OWNER_ID }))?.title).toBe(
      'Chosen already',
    )
  })

  it('changes nothing when there is no message to name it after', async () => {
    const { store, session } = await storeWithSession()

    expect(
      await nameSessionFromFirstMessage(
        store,
        session.id,
        [{ type: EVENT_TYPES.userInterrupt }],
        TEST_OWNER_ID,
      ),
    ).toBeNull()
    expect(await nameSessionFromFirstMessage(store, session.id, [], TEST_OWNER_ID)).toBeNull()
    expect((await store.getSession(session.id, { ownerId: TEST_OWNER_ID }))?.title).toBeNull()
  })
})
