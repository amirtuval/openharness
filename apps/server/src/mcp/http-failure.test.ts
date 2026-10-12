import { MCP_LAST_ERROR_MAX_LENGTH } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { describeMcpFailure, recordingMcpFetch, type McpHttpObservation } from './http-failure'

/**
 * What a failed MCP request is reported with (epic #303, X10; issues #314, #316).
 *
 * The two things the SDK's own message cannot say are the status and the server's own reason for
 * it, and this is where both are read: the recording fetch remembers a failing response's status,
 * its bounded body, the `WWW-Authenticate` header's `error`/`error_description` and whether the
 * request carried an `Authorization` header at all, and the formatter turns that into one
 * bounded, secret-free sentence.
 *
 * A resource server's 401 is **empty by design** (Linear's is), so the header is often the only
 * thing there is to read — and "a 401 from a request that sent no credential" is a different
 * fault from "a credential the server refused", which the status alone cannot tell apart.
 */

/** A response the fetch seam can answer with. */
function response(
  status: number,
  options: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Response {
  return new Response(options.body ?? null, { status, headers: options.headers })
}

/** An observation with everything a case does not care about defaulted. */
function observation(overrides: Partial<McpHttpObservation> = {}): McpHttpObservation {
  return {
    status: 401,
    statusText: '',
    body: '',
    hadAuthorization: true,
    ...overrides,
  }
}

describe('the recording fetch remembers what a failing response said', () => {
  it('reads the WWW-Authenticate reason and the bounded body', async () => {
    const recorder = recordingMcpFetch(() =>
      Promise.resolve(
        response(401, {
          headers: {
            // The shape Linear answers with: a challenge naming the OAuth metadata, and the
            // machine-readable reason this deployment needs to read.
            'www-authenticate':
              'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="the token expired"',
            'content-type': 'application/json',
          },
          body: '{"error":"invalid_token"}',
        }),
      ),
    )

    await recorder.fetch('https://mcp.linear.app/mcp', {
      headers: { Authorization: 'Bearer a-token' },
    })
    expect(recorder.lastFailure()).toEqual({
      status: 401,
      statusText: '',
      body: '{"error":"invalid_token"}',
      authError: 'invalid_token',
      authDescription: 'the token expired',
      hadAuthorization: true,
    })
  })

  it('notes whether the request carried an Authorization header, in either shape', async () => {
    // The SDK's transport hands the fetch a `Headers` object; a caller that built its own init
    // hands a record, and the name is case-insensitive either way.
    const recorder = recordingMcpFetch(() => Promise.resolve(response(401)))
    await recorder.fetch('https://mcp.example.com/mcp', {
      headers: new Headers({ authorization: 'Bearer a-token' }),
    })
    expect(recorder.lastFailure()?.hadAuthorization).toBe(true)

    await recorder.fetch('https://mcp.example.com/mcp', { headers: { AUTHORIZATION: 'Bearer t' } })
    expect(recorder.lastFailure()?.hadAuthorization).toBe(true)

    await recorder.fetch('https://mcp.example.com/mcp', {})
    expect(recorder.lastFailure()?.hadAuthorization).toBe(false)

    // Someone else's headers are not an Authorization header.
    await recorder.fetch('https://mcp.example.com/mcp', { headers: [['x-team', 'eng']] })
    expect(recorder.lastFailure()?.hadAuthorization).toBe(false)
  })

  it('keeps nothing from a successful response, and only the last failure', async () => {
    let status = 200
    const recorder = recordingMcpFetch(() => Promise.resolve(response(status)))
    await recorder.fetch('https://mcp.example.com/mcp')
    expect(recorder.lastFailure()).toBeNull()

    status = 500
    await recorder.fetch('https://mcp.example.com/mcp')
    expect(recorder.lastFailure()?.status).toBe(500)
    status = 401
    await recorder.fetch('https://mcp.example.com/mcp')
    expect(recorder.lastFailure()?.status).toBe(401)
  })
})

describe('the sentence a failure is reported with', () => {
  it('names the header’s reason for an empty-bodied 401', () => {
    // The maintainer's own failure: the SDK's message stopped at "Error POSTing to endpoint:"
    // because the body was empty, and the reason was in the header all along.
    expect(
      describeMcpFailure(new Error('Error POSTing to endpoint:'), {
        status: 401,
        statusText: '',
        body: '',
        authError: 'invalid_token',
        authDescription: 'the token expired',
        hadAuthorization: true,
      }),
    ).toBe('the MCP server answered 401 (invalid_token: the token expired)')
  })

  it('says so when the reason is only the error parameter', () => {
    expect(describeMcpFailure(null, observation({ authError: 'insufficient_scope' }))).toBe(
      'the MCP server answered 401 (insufficient_scope)',
    )
  })

  it('keeps the body excerpt, and the old words when there is neither', () => {
    expect(
      describeMcpFailure(null, observation({ status: 403, body: '{"error":"forbidden"}' })),
    ).toBe('the MCP server answered 403: {"error":"forbidden"}')
    // The wording the first fix established, unchanged for a response that says nothing at all
    // and carries no challenge.
    expect(describeMcpFailure(null, observation({ statusText: 'Unauthorized' }))).toBe(
      'the MCP server answered 401 Unauthorized, with no message',
    )
  })

  it('tells a 401 sent without a credential from one with a rejected credential', () => {
    const withoutCredential = describeMcpFailure(
      null,
      observation({ hadAuthorization: false, authDescription: undefined }),
    )
    expect(withoutCredential).toBe(
      'the MCP server answered 401, with no message — the request carried no Authorization header',
    )
    // With a credential the status says everything there is to say; nothing extra is added.
    expect(describeMcpFailure(null, observation({ body: 'nope' }))).toBe(
      'the MCP server answered 401: nope',
    )
    // A 403 is never reported that way: the request carried one, or the server would have
    // answered differently.
    expect(
      describeMcpFailure(null, observation({ status: 403, hadAuthorization: false })),
    ).not.toContain('carried no Authorization header')
  })

  it('scrubs what this deployment sent and bounds the whole', () => {
    const message = describeMcpFailure(
      null,
      observation({ body: 'your token Bearer a-real-token was refused', status: 401 }),
      ['Bearer a-real-token'],
    )
    expect(message).not.toContain('a-real-token')
    expect(message).toContain('[redacted]')

    const long = describeMcpFailure(null, observation({ body: 'x'.repeat(1000) }))
    expect(long).toHaveLength(MCP_LAST_ERROR_MAX_LENGTH)
  })

  it('falls back to the thrown error when there was no response at all', () => {
    expect(describeMcpFailure(new Error('fetch failed'), null)).toBe(
      'no response from the MCP server: fetch failed',
    )
    expect(describeMcpFailure(null, null)).toBe(
      'no response from the MCP server, and no reason was reported',
    )
  })
})
