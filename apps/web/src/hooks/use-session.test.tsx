import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { makeFake } from '../test-support/render-app'
import { useSession } from './use-session'

/**
 * `useSession` on its own, for the parts the chat screen cannot show: the state it hands back
 * and what a failed request does to it.
 */
describe('useSession', () => {
  it('reports a failed history load without throwing', async () => {
    const fake = makeFake()
    const { result } = renderHook(() => useSession(fake, 'sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ'))

    await waitFor(() => {
      expect(result.current.requestError).toMatch(/No session/)
    })
    expect(result.current.loadingHistory).toBe(false)
    expect(result.current.messages).toEqual([])
    expect(result.current.status).toBe('idle')
  })

  it('loads the session, sends, and follows the reply — without duplicating the message', async () => {
    const fake = makeFake()
    fake.respondWith('A reply.')
    const { result } = renderHook(() => useSession(fake, fake.session.id))

    await waitFor(() => {
      expect(result.current.session).not.toBeNull()
    })
    expect(result.current.loadingHistory).toBe(false)

    await act(async () => {
      await result.current.send('a message')
    })

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.text)).toEqual([
        'a message',
        'A reply.',
      ])
    })

    // The sent message went in twice — once from the response, once from the stream — and the
    // transcript's `seq` rule kept one copy.
    expect(fake.history().filter((event) => event.type === 'user.message')).toHaveLength(1)
    expect(result.current.lastSeq).toBeGreaterThan(0)
    expect(result.current.status).toBe('idle')
  })
})
