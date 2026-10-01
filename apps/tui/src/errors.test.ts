import { ApiError, AuthenticationError, ResponseValidationError } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import { describeError, notSignedInMessage } from './errors'

const SERVER = 'http://localhost:3000'

describe('describeError', () => {
  it('turns a 401 into the not-signed-in line, whichever error carries it', () => {
    for (const error of [
      new AuthenticationError('Not signed in.'),
      new ApiError(401, 'no session', { type: 'authentication_error' }),
    ]) {
      const report = describeError(error, { server: SERVER })

      expect(report.message).toBe(`not signed in to ${SERVER}. Run \`oh login\`.`)
      expect(report.hints).toEqual([])
    }
  })

  it('falls back to "the server" when the caller does not know which one', () => {
    expect(describeError(new AuthenticationError('Not signed in.')).message).toBe(
      notSignedInMessage(undefined),
    )
  })

  it('points a 404 at the id', () => {
    const report = describeError(
      new ApiError(404, 'no such session', { type: 'not_found_error' }),
      {
        server: SERVER,
      },
    )

    expect(report.message).toContain('not found')
    expect(report.hints.join(' ')).toContain('oh sessions')
  })

  it('points a refused connection at the server URL', () => {
    const failure = new TypeError('fetch failed')
    Object.assign(failure, {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })

    const report = describeError(failure, { server: SERVER })

    expect(report.message).toContain(SERVER)
    expect(report.hints.join(' ')).toContain('--server')
  })

  it('reads an error code out of the cause chain', () => {
    const failure = new TypeError('fetch failed')
    Object.assign(failure, { cause: new Error('getaddrinfo ENOTFOUND nope.test') })
    Object.assign(failure.cause as Error, { code: 'ENOTFOUND' })

    const report = describeError(failure, { server: SERVER })

    expect(report.hints.join(' ')).toContain('host name')
  })

  it('explains a response the protocol did not parse', () => {
    const report = describeError(new ResponseValidationError(200, 'bad body'), { server: SERVER })

    expect(report.message).toContain('could not read')
    expect(report.hints.join(' ')).toContain(SERVER)
  })

  it('reports an abort as a cancellation', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'

    expect(describeError(abort).message).toBe('the request was cancelled.')
  })

  it('keeps a plain error’s message', () => {
    expect(describeError(new Error('no agent matches')).message).toBe('no agent matches')
  })

  it('keeps a stack only under --debug', () => {
    const error = new Error('boom')

    expect(describeError(error).stack).toBeUndefined()
    expect(describeError(error, { debug: true }).stack).toContain('boom')
  })

  it('describes something that is not an error at all', () => {
    expect(describeError('nope').message).toBe('nope')
  })
})
