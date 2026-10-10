import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type ListProviderCredentialsResponse,
  type ProviderCredential,
  type SessionErrorEvent,
} from '@openharness/protocol'
import { InMemoryCredentialStore, InMemorySessionStore } from '@openharness/session'
import { createVault, envKeyProvider } from '@openharness/vault'

import { SESSION_FRESH_AGE_SECONDS } from './auth'
import { createSessionCredentialResolver, openCredential } from './credentials'
import {
  TEST_SECRETS_KEY,
  createTestApp,
  httpCreateAgent,
  httpCreateSession,
  readHistory,
  waitForIdle,
  type TestContext,
} from './test-support'
import type { Logger } from './types'

/**
 * Provider credentials (epic #65, A5): the write-only round trip, the validation on save, the
 * freshness requirement, the sealing, and the two things that must never happen — a key in a
 * response or a log line, and the environment standing in for a missing credential.
 */

/** A distinctive key, so "it is not in the output" is a meaningful assertion. */
const SECRET = 'sk-live-do-not-log-me-424242424242'

/** `PUT /v1/provider-credentials/{provider}` as the context's default caller. */
async function putCredential(
  test: TestContext,
  provider: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return test.request(`${API_VERSION_PREFIX}/provider-credentials/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
    ...init,
  })
}

/** `GET /v1/provider-credentials`. */
async function listCredentials(test: TestContext): Promise<ListProviderCredentialsResponse> {
  const response = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
  return (await response.json()) as ListProviderCredentialsResponse
}

/** A logger that keeps every line, for the "never in the logs" assertions. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = []
  const write = (level: string, message: string, detail?: unknown): void => {
    lines.push(`${level} ${message} ${detail === undefined ? '' : (JSON.stringify(detail) ?? '')}`)
  }
  return {
    lines,
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  }
}

describe('the provider-credential API', () => {
  it('round-trips a key as metadata only: put, list, replace, delete', async () => {
    const test = createTestApp()

    const put = await putCredential(test, 'anthropic', { type: 'api_key', api_key: SECRET })
    expect(put.status).toBe(200)
    const created = (await put.json()) as ProviderCredential
    expect(created.type).toBe('api_key')
    expect(created.name).toBe('anthropic')
    expect(created.last4).toBe(SECRET.slice(-4))
    expect(created.validated_at).toBeDefined()
    expect(JSON.stringify(created)).not.toContain(SECRET)

    const listed = await listCredentials(test)
    expect(listed.data).toEqual([created])

    // Replacing keeps the row's id and created_at, and moves last4.
    const replaced = await putCredential(test, 'anthropic', {
      type: 'api_key',
      api_key: 'sk-rotated-0000000000009999',
    })
    const afterReplace = (await replaced.json()) as ProviderCredential
    expect(afterReplace.id).toBe(created.id)
    expect(afterReplace.created_at).toBe(created.created_at)
    expect(afterReplace.last4).toBe('9999')
    expect((await listCredentials(test)).data).toEqual([afterReplace])

    const deleted = await test.request(`${API_VERSION_PREFIX}/provider-credentials/anthropic`, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(204)
    expect(await deleted.text()).toBe('')
    expect((await listCredentials(test)).data).toEqual([])

    // Deleting again is not an error: the caller's state is "no credential" either way.
    const again = await test.request(`${API_VERSION_PREFIX}/provider-credentials/anthropic`, {
      method: 'DELETE',
    })
    expect(again.status).toBe(204)
  })

  it('stores the key sealed by the vault, bound to its user and provider', async () => {
    const test = createTestApp()

    await putCredential(test, 'openai', { type: 'api_key', api_key: SECRET })

    const user = await test.currentUser()
    const stored = await test.credentials.get({ userId: user.id, name: 'openai' })
    expect(stored).not.toBeNull()
    expect(JSON.stringify(stored)).not.toContain(SECRET)
    expect(stored?.sealed.kekVersion).toBe('v1')

    // The vault opens it with the same AAD, and only that one: another user or another
    // provider cannot decrypt the row.
    const sealed = stored?.sealed as never
    const payload = { type: 'api_key', api_key: SECRET }
    await expect(
      openCredential(test.vault, { userId: user.id, name: 'openai', sealed }),
    ).resolves.toEqual(payload)
    await expect(
      openCredential(test.vault, { userId: 'somebody-else', name: 'openai', sealed }),
    ).resolves.toBeNull()
    await expect(
      openCredential(test.vault, { userId: user.id, name: 'anthropic', sealed }),
    ).resolves.toBeNull()
  })

  it('validates the key with one provider call, and answers 422 when it is refused', async () => {
    const calls: { name: string; apiKey: string }[] = []
    const test = createTestApp({
      validateProviderCredential: (name, body) => {
        calls.push({ name, apiKey: body.api_key ?? '' })
        if (body.api_key !== SECRET) {
          return Promise.reject(
            new Error('openai answered 401 for the validating request; the key was rejected'),
          )
        }
        return Promise.resolve()
      },
    })

    const refused = await putCredential(test, 'openai', { type: 'api_key', api_key: 'sk-nope' })
    expect(refused.status).toBe(422)
    const body = ApiErrorBodySchema.parse(await refused.json())
    expect(body.error.type).toBe('invalid_provider_credential')
    expect(body.error.message).toContain('openai')
    expect(body.error.message).not.toContain('sk-nope')
    expect(calls).toEqual([{ name: 'openai', apiKey: 'sk-nope' }])

    // Nothing was stored by the failed save.
    expect((await listCredentials(test)).data).toEqual([])

    const accepted = await putCredential(test, 'openai', { type: 'api_key', api_key: SECRET })
    expect(accepted.status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it('requires a fresh session for a write, and allows a read (A2)', async () => {
    const test = createTestApp()
    const { token } = await test.signIn()
    const user = await test.currentUser()

    // Backdate the session the token is bound to: what a session older than `freshAge` looks
    // like when it comes back a week later.
    const context = (await test.auth.auth.$context) as unknown as {
      adapter: { update(args: unknown): Promise<unknown> }
    }
    await context.adapter.update({
      model: 'session',
      where: [{ field: 'userId', value: user.id }],
      update: {
        createdAt: new Date(Date.now() - (SESSION_FRESH_AGE_SECONDS + 60) * 1000),
      },
    })

    const refusedPut = await putCredential(
      test,
      'openai',
      { type: 'api_key', api_key: SECRET },
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(refusedPut.status).toBe(401)
    expect(ApiErrorBodySchema.parse(await refusedPut.json()).error.type).toBe(
      'authentication_error',
    )

    const refusedDelete = await test.request(`${API_VERSION_PREFIX}/provider-credentials/openai`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(refusedDelete.status).toBe(401)

    // A read is not sensitive: the settings screen can still show what is stored.
    const read = await test.request(`${API_VERSION_PREFIX}/provider-credentials`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(read.status).toBe(200)
  })

  it('never puts the key in a response or a log line', async () => {
    const logger = recordingLogger()
    const test = createTestApp({ logger })
    const rejected = `${SECRET}-rejected`

    const put = await putCredential(test, 'anthropic', { type: 'api_key', api_key: SECRET })
    const refused = await putCredential(test, 'openai', { type: 'api_key', api_key: rejected })
    const list = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
    const del = await test.request(`${API_VERSION_PREFIX}/provider-credentials/anthropic`, {
      method: 'DELETE',
    })

    for (const response of [put, refused, list, del]) {
      const text = await response.clone().text()
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(rejected)
    }
    const logged = logger.lines.join('\n')
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain(rejected)
  })

  it('refuses a provider name that is not a provider name', async () => {
    const test = createTestApp()

    const response = await putCredential(test, 'not%20a%20provider', {
      type: 'api_key',
      api_key: SECRET,
    })

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })
})

describe('the environment is not a credential source (A5)', () => {
  it('ends a turn with missing_provider_credential while OPENAI_API_KEY is set', async () => {
    // The real lookup, over the context's own store/credentials/vault — the same resolver a
    // deployment builds in `main.ts`. The session has no stored key, so the turn must end with
    // the brain's error even though the process environment carries one, which nothing reads.
    const previous = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'sk-env-key-that-must-not-be-used'
    try {
      const store = new InMemorySessionStore()
      const credentials = new InMemoryCredentialStore()
      const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
      const test = createTestApp({
        store,
        credentials,
        vault,
        resolveCredential: createSessionCredentialResolver({ store, credentials, vault }),
      })
      const agent = await httpCreateAgent(test, { model: { id: 'openai/gpt-5.1' } })
      const session = await httpCreateSession(test, agent.id)

      const response = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
        }),
      })
      expect(response.status).toBe(200)
      await waitForIdle(store, session.id)

      const history = await readHistory(store, session.id)
      const error = history.find(
        (event): event is SessionErrorEvent => event.type === EVENT_TYPES.sessionError,
      )
      expect(error?.error.type).toBe('missing_provider_credential')
      expect(error?.error.message).toContain('OpenAI')
      // No model request was made: the credential is checked before the request is built, so
      // the environment key could not have been used even silently.
      expect(history.some((event) => event.type === EVENT_TYPES.modelRequestStart)).toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env['OPENAI_API_KEY']
      } else {
        process.env['OPENAI_API_KEY'] = previous
      }
    }
  })

  it('resolves the stored key for the session’s owner, and nothing else', async () => {
    const store = new InMemorySessionStore()
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({ store, credentials, vault })
    const user = await test.currentUser()
    await putCredential(test, 'openai', { type: 'api_key', api_key: SECRET })

    const agent = await store.createAgent({ name: 'A', model: { id: 'openai/gpt-5.1' } }, user.id)
    const session = await store.createSession(agent.id, { ownerId: user.id })
    const resolver = createSessionCredentialResolver({ store, credentials, vault })

    await expect(resolver(session.id, 'openai')).resolves.toEqual({
      type: 'api_key',
      apiKey: SECRET,
    })
    // A provider the user has no key for, and a session that does not exist, both answer none.
    await expect(resolver(session.id, 'anthropic')).resolves.toBeNull()
    await expect(resolver('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ' as never, 'openai')).resolves.toBeNull()
  })
})
