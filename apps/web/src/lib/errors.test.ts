import { ApiError } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import { describeError } from './errors'

const SERVER = 'http://localhost:3000'
const UNREACHABLE_AT = (where: string): string =>
  `Can't reach the openharness server at ${where}. Check that it's running, or change the server URL in Settings.`

/** What a failed `fetch` throws, per browser. */
describe('describeError', () => {
  it('names the configured server when the request never got there', () => {
    expect(describeError(new TypeError('Failed to fetch'), { serverUrl: SERVER })).toBe(
      UNREACHABLE_AT(SERVER),
    )
  })

  it('says "this site" when the app calls its own origin', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe(UNREACHABLE_AT('this site'))
    expect(describeError(new TypeError('Failed to fetch'), { serverUrl: '  ' })).toBe(
      UNREACHABLE_AT('this site'),
    )
  })

  it('recognises what each browser calls a transport failure', () => {
    const messages = [
      'Failed to fetch', // Chromium
      'NetworkError when attempting to fetch resource.', // Firefox
      'Load failed', // Safari
      'fetch failed', // Node, and the client under test
    ]

    for (const message of messages) {
      expect(describeError(new TypeError(message), { serverUrl: SERVER })).toBe(
        UNREACHABLE_AT(SERVER),
      )
    }

    expect(describeError(new DOMException('NetworkError', 'NetworkError'), {})).toBe(
      UNREACHABLE_AT('this site'),
    )
  })

  it('recognises a refused connection buried in the cause chain', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
      code: 'ECONNREFUSED',
    })
    const error = new TypeError('fetch failed', { cause: refused })

    expect(describeError(error, { serverUrl: SERVER })).toBe(UNREACHABLE_AT(SERVER))
  })

  it('hints at the API key when the server will not take ours', () => {
    const error = new ApiError(401, 'Invalid API key.')

    expect(describeError(error)).toBe(
      'The server rejected the request (401): Invalid API key. Check the API key in Settings.',
    )
    expect(describeError(new ApiError(403, 'Forbidden.'))).toContain(
      'Check the API key in Settings.',
    )
  })

  it('keeps the server’s own words for everything else', () => {
    expect(describeError(new ApiError(404, 'No session sesn_1.'))).toBe('No session sesn_1.')
    expect(describeError(new Error('The model request failed.'))).toBe('The model request failed.')
  })

  it('does not report a cancelled request as a failure', () => {
    expect(describeError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(
      'The request was cancelled.',
    )
    expect(describeError(new Error('The operation was aborted.'), { serverUrl: SERVER })).not.toBe(
      UNREACHABLE_AT(SERVER),
    )
  })

  it('has a last resort for anything that is not an error at all', () => {
    expect(describeError('a string')).toBe('a string')
    expect(describeError(undefined)).toBe('Something went wrong.')
    expect(describeError(new Error(''))).toBe('Error')
  })
})
