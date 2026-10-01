import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, SESSION_TITLE_MAX_LENGTH } from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'

import { PLACEHOLDER_OWNER_ID } from './placeholder-owner'
import { deriveSessionTitle, nameSessionFromFirstMessage } from './titles'

/**
 * Naming a session after its first message: the derivation itself, and the one rule the write
 * path has to keep — a title that exists is never replaced.
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
    PLACEHOLDER_OWNER_ID,
  )
  const session = await store.createSession(agent.id, { ownerId: PLACEHOLDER_OWNER_ID })
  return { store, session }
}

describe('deriveSessionTitle', () => {
  it('takes the first non-empty line of the message', () => {
    expect(deriveSessionTitle('Fix the SSE reload bug\n\nIt never replays previews')).toBe(
      'Fix the SSE reload bug',
    )
    expect(deriveSessionTitle('\n\n   \nSecond line is the first with text')).toBe(
      'Second line is the first with text',
    )
  })

  it('collapses whitespace and trims the ends', () => {
    expect(deriveSessionTitle('   Fix\t\t the   reload \t bug   ')).toBe('Fix the reload bug')
    expect(deriveSessionTitle('one\r\ntwo\rthree')).toBe('one')
  })

  it('truncates a long line to the protocol maximum, ending it with an ellipsis', () => {
    const long = 'word '.repeat(300).trim()
    const title = deriveSessionTitle(long)
    expect(title).not.toBeNull()
    expect(title?.length).toBe(SESSION_TITLE_MAX_LENGTH)
    expect(title?.endsWith('…')).toBe(true)
    expect(long.startsWith(title?.slice(0, -1) ?? '')).toBe(true)
  })

  it('leaves a line of exactly the maximum alone', () => {
    const exact = 'x'.repeat(SESSION_TITLE_MAX_LENGTH)
    expect(deriveSessionTitle(exact)).toBe(exact)
    expect(deriveSessionTitle(`${exact} and one more word`)).toHaveLength(SESSION_TITLE_MAX_LENGTH)
  })

  it('does not cut a surrogate pair in half', () => {
    // Each 🌊 is two UTF-16 units, so a cut at an odd position would leave half of one behind.
    const waves = '🌊'.repeat(SESSION_TITLE_MAX_LENGTH)
    const title = deriveSessionTitle(waves) ?? ''
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_LENGTH)
    // The character before the ellipsis is not a high surrogate waiting for its other half.
    expect(/[\uD800-\uDBFF]$/.test(title.slice(0, -1))).toBe(false)
  })

  it('answers null when there is nothing to name a session after', () => {
    expect(deriveSessionTitle('')).toBeNull()
    expect(deriveSessionTitle('   \n\t\n ')).toBeNull()
  })
})

describe('nameSessionFromFirstMessage', () => {
  it('names a session after the first message of a batch', async () => {
    const { store, session } = await storeWithSession()

    const named = await nameSessionFromFirstMessage(store, session.id, [
      { type: EVENT_TYPES.userInterrupt },
      userMessage('Tell me about the session log'),
    ])

    expect(named?.title).toBe('Tell me about the session log')
    expect((await store.getSession(session.id))?.title).toBe('Tell me about the session log')
  })

  it('leaves a title that already exists alone', async () => {
    const { store, session } = await storeWithSession()
    await store.updateSession(session.id, { title: 'Chosen already' })

    const named = await nameSessionFromFirstMessage(store, session.id, [
      userMessage('a message that would have named it otherwise'),
    ])

    expect(named).toBeNull()
    expect((await store.getSession(session.id))?.title).toBe('Chosen already')
  })

  it('changes nothing when there is no message to name it after', async () => {
    const { store, session } = await storeWithSession()

    expect(
      await nameSessionFromFirstMessage(store, session.id, [{ type: EVENT_TYPES.userInterrupt }]),
    ).toBeNull()
    expect(await nameSessionFromFirstMessage(store, session.id, [])).toBeNull()
    expect((await store.getSession(session.id))?.title).toBeNull()
  })
})
