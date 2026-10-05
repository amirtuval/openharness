import { describe, expect, it } from 'vitest'

import {
  REDACTED,
  detailFields,
  isSensitiveKey,
  jsonLogger,
  loggerFor,
  redact,
  redactError,
} from './logging'
import { runWithTraceContext } from './trace-context'

/** A logger whose lines are kept, with a fixed clock. */
function capturing(options: { projectId?: string } = {}) {
  const lines: string[] = []
  const logger = jsonLogger({
    ...options,
    write: (line) => lines.push(line),
    now: () => new Date('2026-10-05T12:34:56.789Z'),
  })
  const parsed = (): Record<string, unknown> =>
    JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
  return { logger, lines, parsed }
}

describe('jsonLogger', () => {
  it('writes one JSON object per line, in the shape Cloud Logging reads', () => {
    const { logger, lines, parsed } = capturing()
    logger.info('@openharness/server listening', { port: 3000 })
    expect(lines).toHaveLength(1)
    // One line per write, terminated: Cloud Logging parses per line.
    expect(lines[0]?.endsWith('\n')).toBe(true)
    expect(parsed()).toEqual({
      severity: 'INFO',
      message: '@openharness/server listening',
      time: '2026-10-05T12:34:56.789Z',
      port: 3000,
    })
  })

  it('uses Cloud Logging severity names for every level', () => {
    const { logger, parsed } = capturing()
    logger.debug('a')
    expect(parsed()['severity']).toBe('DEBUG')
    logger.info('b')
    expect(parsed()['severity']).toBe('INFO')
    logger.warn('c')
    expect(parsed()['severity']).toBe('WARNING')
    logger.error('d')
    expect(parsed()['severity']).toBe('ERROR')
  })

  it('merges a detail object into the line, so its fields are top-level', () => {
    const { logger, parsed } = capturing()
    logger.error('unhandled error', {
      method: 'POST',
      path: '/v1/sessions',
      status: 500,
      request_id: 'req_1',
    })
    expect(parsed()).toMatchObject({
      message: 'unhandled error',
      method: 'POST',
      path: '/v1/sessions',
      status: 500,
      request_id: 'req_1',
    })
  })

  it('keeps a non-object detail under `detail`, and an Error under `error`', () => {
    const { logger, parsed } = capturing()
    logger.info('a string detail', 'raw')
    expect(parsed()['detail']).toBe('raw')
    logger.error('failed', new Error('boom'))
    expect(parsed()['error']).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('tags every line with the active trace, joined to the project when it is known', () => {
    const { logger, parsed } = capturing({ projectId: 'openharness-dev' })
    runWithTraceContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true }, () => {
      logger.info('inside a request')
    })
    expect(parsed()).toMatchObject({
      'logging.googleapis.com/trace': `projects/openharness-dev/traces/${'a'.repeat(32)}`,
      'logging.googleapis.com/spanId': 'b'.repeat(16),
    })
  })

  it('writes the bare trace id when no project is known, and omits an absent span', () => {
    const { logger, parsed } = capturing()
    runWithTraceContext(
      { traceId: 'c'.repeat(32), spanId: '0000000000000000', sampled: false },
      () => {
        logger.info('inside a request')
      },
    )
    expect(parsed()['logging.googleapis.com/trace']).toBe('c'.repeat(32))
    expect(parsed()).not.toHaveProperty('logging.googleapis.com/spanId')
  })

  it('writes no trace fields outside a request', () => {
    const { logger, parsed } = capturing({ projectId: 'openharness-dev' })
    logger.info('startup')
    expect(parsed()).not.toHaveProperty('logging.googleapis.com/trace')
    expect(parsed()).not.toHaveProperty('logging.googleapis.com/spanId')
  })
})

describe('redaction', () => {
  it('recognizes a field name that holds a credential', () => {
    for (const name of [
      'authorization',
      'Authorization',
      'cookie',
      'Cookie',
      'set-cookie',
      'x-api-key',
      'apiKey',
      'client_secret',
      'GITHUB_CLIENT_SECRET',
      'access_token',
      'refresh_token',
      'password',
      'private_key',
      'credentials',
    ]) {
      expect(isSensitiveKey(name), name).toBe(true)
    }
    // The model usage counters are not credentials, however much they look like one.
    for (const name of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'session_id']) {
      expect(isSensitiveKey(name), name).toBe(false)
    }
  })

  it('replaces the value of every sensitive field, whatever its type', () => {
    expect(
      redact({
        authorization: 'Bearer sk-live-123',
        apiKey: 'sk-live-456',
        client_secret: 'shh',
        cookie: 'openharness.session=abc',
        password: 'hunter2',
        session_id: 'sesn_1',
        input_tokens: 42,
      }),
    ).toEqual({
      authorization: REDACTED,
      apiKey: REDACTED,
      client_secret: REDACTED,
      cookie: REDACTED,
      password: REDACTED,
      session_id: 'sesn_1',
      input_tokens: 42,
    })
  })

  it('walks nested objects and arrays', () => {
    expect(redact({ outer: { inner: [{ token: 't' }, { keep: 'this' }] } })).toEqual({
      outer: { inner: [{ token: REDACTED }, { keep: 'this' }] },
    })
  })

  it('turns an Error into its fields, and cuts a cycle rather than throwing', () => {
    const error = new Error('boom')
    expect(redactError(error)).toMatchObject({ name: 'Error', message: 'boom' })
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic
    expect(() => redact(cyclic)).not.toThrow()
    expect((redact(cyclic) as Record<string, unknown>)['self']).toBe('[Circular]')
  })

  it('never writes a secret into the line — the whole point', () => {
    const { logger, lines } = capturing()
    logger.error('a request failed', {
      authorization: 'Bearer sk-live-do-not-log',
      cookie: 'openharness.session=do-not-log',
      headers: { 'x-api-key': 'do-not-log-either' },
      nested: [{ client_secret: 'nor-this' }],
    })
    const line = lines[0] ?? ''
    for (const secret of ['sk-live-do-not-log', 'do-not-log', 'do-not-log-either', 'nor-this']) {
      expect(line).not.toContain(secret)
    }
    expect(line).toContain(REDACTED)
  })

  it('detailFields lifts an object, boxes a scalar, and names an Error', () => {
    expect(detailFields(undefined)).toEqual({})
    expect(detailFields({ a: 1 })).toEqual({ a: 1 })
    expect(detailFields([1, 2])).toEqual({ detail: [1, 2] })
    expect(detailFields(new Error('x'))).toMatchObject({ error: { name: 'Error', message: 'x' } })
  })
})

describe('loggerFor', () => {
  it('picks the JSON logger only for `json`, the console one otherwise', () => {
    // Both are `Logger`s; neither is called here, so a JSON line never lands in the test
    // output. The shape is asserted above, through an injected sink.
    expect(loggerFor('json')).not.toBe(loggerFor('text'))
    expect(typeof loggerFor('json').warn).toBe('function')
    expect(typeof loggerFor('text').warn).toBe('function')
  })
})
