import { ApiError, AuthenticationError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { describe, expect, it } from 'vitest'

import {
  authStateFor,
  beginSessionCheck,
  markSignedIn,
  noteAuthenticationError,
} from './auth-store'

/**
 * The auth store's own contract (#105, P2): **any 401 becomes sign-in**, the hand-built
 * `ApiError` 401 branch included; a client this store has not met reports `checking`; an
 * answer from a client that is no longer the current one is dropped; and `markSignedIn`
 * records a user. The app-level paths (the startup read, a 401 from any call) are exercised
 * through the fake elsewhere; these are the rules themselves.
 */

describe('the auth store', () => {
  it('has no answer for a client it has not met', () => {
    const client = createFakeClient()

    expect(authStateFor(client)).toEqual({ status: 'checking' })
  })

  it('turns an AuthenticationError into signed-out', () => {
    const client = createFakeClient()
    markSignedIn(client, client.user)
    expect(authStateFor(client)).toEqual({ status: 'signed-in', user: client.user })

    expect(noteAuthenticationError(client, new AuthenticationError('Not signed in.'))).toBe(true)
    expect(authStateFor(client)).toEqual({ status: 'signed-out' })
  })

  it('treats a hand-built 401 ApiError as the same rule', () => {
    const client = createFakeClient()
    markSignedIn(client, client.user)

    // A wrapper that rebuilt the error, an interceptor, a fake: the status is the rule, not
    // the class the client happens to use.
    expect(noteAuthenticationError(client, new ApiError(401, 'Nope.'))).toBe(true)
    expect(authStateFor(client)).toEqual({ status: 'signed-out' })
  })

  it('leaves failures that are not 401s alone', () => {
    const client = createFakeClient()
    markSignedIn(client, client.user)

    expect(noteAuthenticationError(client, new ApiError(500, 'Boom.'))).toBe(false)
    expect(noteAuthenticationError(client, new TypeError('Failed to fetch'))).toBe(false)
    expect(noteAuthenticationError(client, 'not even an error')).toBe(false)
    expect(authStateFor(client)).toEqual({ status: 'signed-in', user: client.user })
  })

  it('drops the answer of a client that is no longer the current one', async () => {
    const first = createFakeClient()
    const second = createFakeClient()
    let answerFirst: (() => void) | undefined
    first.me = () =>
      new Promise((resolve) => {
        answerFirst = () => {
          resolve(first.user)
        }
      })

    const checkingFirst = beginSessionCheck(first)
    await beginSessionCheck(second)

    expect(authStateFor(second)).toEqual({ status: 'signed-in', user: second.user })

    // The settings screen rebuilt the client; by the time the old check answers, its answer
    // is about a server the app is no longer pointed at, and is dropped.
    answerFirst?.()
    await checkingFirst

    expect(authStateFor(first)).toEqual({ status: 'checking' })
    expect(authStateFor(second)).toEqual({ status: 'signed-in', user: second.user })
  })

  it('records the user a sign-in answered with', () => {
    const client = createFakeClient()

    markSignedIn(client, client.user)

    expect(authStateFor(client)).toEqual({ status: 'signed-in', user: client.user })
  })
})
