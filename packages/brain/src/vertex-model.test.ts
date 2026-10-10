import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createProviderModelFactory,
  credentialSecrets,
  isUsableCredential,
  missingCredentialMessage,
  providerModelFactory,
  streamModelRequest,
  type VertexModelCredential,
} from './model'
import { isVertexAnthropicModel, isVertexModelId } from './vertex'

/**
 * Google Vertex as a model client (epic #245, A3d).
 *
 * The thing this file exists for is the last block: a request built from a Vertex credential
 * must be authenticated by **the stored service-account key and nothing else**. That matters
 * more here than anywhere else in this package, because the server itself runs on GCP: a
 * request that fell back to Application Default Credentials would quietly run a user's chat on
 * openharness's own service account, and the user would be none the wiser. Every decoy the
 * environment can offer is set below — a different credentials file, a project, a gcloud config
 * directory, a metadata server that hands out working tokens, and the express-mode API key —
 * and the request still goes out signed by the key the credential carried.
 */

const PROJECT = 'openharness-vertex'
const LOCATION = 'europe-west4'

/** A throwaway key pair; the private half is what a request signs its token assertion with. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: PROJECT,
  private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
  client_id: '118204773655879341057',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const CREDENTIAL: VertexModelCredential = {
  type: 'vertex',
  project: PROJECT,
  location: LOCATION,
  serviceAccount: JSON.stringify(SERVICE_ACCOUNT),
}

/** The URL a provider asked for, whichever shape it handed the `fetch`. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

describe('the Vertex model families', () => {
  it('gives the Gemini client Google’s own models and the Anthropic client claude-*', () => {
    for (const id of ['gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemini-flash-latest']) {
      expect(isVertexModelId(id), id).toBe(true)
      expect(isVertexAnthropicModel(id), id).toBe(false)
    }
    for (const id of ['claude-sonnet-4-5@20250929', 'claude-opus-4-8@default']) {
      expect(isVertexModelId(id), id).toBe(true)
      expect(isVertexAnthropicModel(id), id).toBe(true)
    }
  })

  it('refuses the models this build has no client for, which Vertex also serves', () => {
    // models.dev's `google-vertex` entry carries more than the two families: the MaaS models
    // Google resells (`xai/…`, `meta/…`) have no client here, and a request for one would go
    // to a publisher endpoint that does not serve it.
    for (const id of [
      'xai/grok-4.7',
      'meta/llama-4-maverick-17b-128e-instruct-maas',
      'zai-org/glm-5-maas',
      'codestral-2',
    ]) {
      expect(isVertexModelId(id), id).toBe(false)
    }
  })

  it('leaves "is it a chat model" to the catalogue, which is where that rule lives', () => {
    // Gemini's image, speech and embedding models share the `gemini-` prefix: this rule is
    // about which *client* builds a request, and the catalogue's name filter is what keeps a
    // non-chat model out of a model list — for every provider, not just this one.
    for (const id of ['gemini-2.5-flash-image', 'gemini-2.5-pro-tts', 'gemini-embedding-001']) {
      expect(isVertexModelId(id), id).toBe(true)
    }
  })
})

describe('a Vertex credential’s usability', () => {
  it('is usable when the key document, the project and the location are all there', () => {
    expect(isUsableCredential(CREDENTIAL)).toBe(true)
  })

  it('is not usable when any of the three is blank', () => {
    // A credential with no key document could not build a request at all; the turn ends with
    // `missing_provider_credential` — the ending that says "save one" — rather than failing on
    // a span. That is also what an *absent* stored key must do, decoys or no decoys.
    expect(isUsableCredential({ ...CREDENTIAL, serviceAccount: '' })).toBe(false)
    expect(isUsableCredential({ ...CREDENTIAL, serviceAccount: '   ' })).toBe(false)
    expect(isUsableCredential({ ...CREDENTIAL, project: '' })).toBe(false)
    expect(isUsableCredential({ ...CREDENTIAL, location: '' })).toBe(false)
    expect(isUsableCredential(null)).toBe(false)
  })
})

describe('credentialSecrets', () => {
  it('is the private key, not the whole document and not the metadata around it', () => {
    // What is scrubbed out of a provider's error text is the secret a request authenticates
    // with. The project, the client email and the key id are metadata a reader may see.
    expect(credentialSecrets(CREDENTIAL)).toEqual([SERVICE_ACCOUNT.private_key])
    expect(credentialSecrets(CREDENTIAL).join()).not.toContain(SERVICE_ACCOUNT.client_email)
  })

  it('is the api key for the key-shaped credentials', () => {
    expect(credentialSecrets({ type: 'api_key', apiKey: 'sk-ant-x' })).toEqual(['sk-ant-x'])
    expect(
      credentialSecrets({ type: 'azure_openai', apiKey: 'az-x', endpoint: 'https://a.example' }),
    ).toEqual(['az-x'])
  })

  it('is nothing at all for a document that cannot be read', () => {
    expect(credentialSecrets({ ...CREDENTIAL, serviceAccount: 'not json' })).toEqual([])
    expect(credentialSecrets({ ...CREDENTIAL, serviceAccount: '[]' })).toEqual([])
  })
})

describe('missingCredentialMessage', () => {
  it('names the credential type a reader has to add', () => {
    expect(missingCredentialMessage('vertex')).toBe(
      'No Google Vertex key is set. Add one in Settings → Model providers.',
    )
    // The other named type, and a fixed provider, are unchanged.
    expect(missingCredentialMessage('azure')).toContain('Azure OpenAI')
    expect(missingCredentialMessage('anthropic')).toContain('Anthropic')
  })
})

describe('a Vertex request never falls back to the environment', () => {
  /**
   * A metadata server that would answer the ADC probe, and hand out a working token.
   *
   * It is a *working* one on purpose. A decoy that failed would prove only that something was
   * broken; this one proves that nothing asked: if any code path had looked for credentials on
   * the instance, the model request would have gone out carrying this token, and the assertions
   * below would see it.
   */
  let metadata: Server
  let metadataRequests: string[]
  let metadataHost: string
  let decoyDir: string

  beforeAll(async () => {
    metadataRequests = []
    metadata = createServer((request, response) => {
      metadataRequests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.setHeader('metadata-flavor', 'Google')
      if (request.url?.endsWith('/token') === true) {
        response.end(
          JSON.stringify({
            access_token: 'decoy-metadata-token',
            expires_in: 3599,
            token_type: 'Bearer',
          }),
        )
        return
      }
      response.end(JSON.stringify({ project: 'decoy-metadata-project' }))
    })
    await new Promise<void>((resolve) => metadata.listen(0, '127.0.0.1', resolve))
    const address = metadata.address()
    metadataHost =
      typeof address === 'object' && address !== null ? `127.0.0.1:${address.port}` : '127.0.0.1:1'

    // A decoy credentials file: the document `gcloud auth application-default login` writes,
    // which authenticates a *person*. It is deliberately a different kind of credential from
    // the one under test, so a fallback that used it would fail in a way this test can tell
    // apart from the stored key being used — and a fallback that used the metadata server
    // would not fail at all.
    decoyDir = mkdtempSync(join(tmpdir(), 'openharness-vertex-decoy-'))
    writeFileSync(
      join(decoyDir, 'decoy-credentials.json'),
      JSON.stringify({
        type: 'authorized_user',
        project_id: 'decoy-project',
        private_key_id: 'decoy-key-id',
        client_id: '999999999999-decoy.apps.googleusercontent.com',
        client_secret: 'decoy-client-secret',
        refresh_token: 'decoy-refresh-token',
      }),
    )
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => metadata.close(() => resolve()))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    metadataRequests.length = 0
  })

  it('signs with the stored key: no decoy is consulted, and no decoy token is used', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', join(decoyDir, 'decoy-credentials.json'))
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'decoy-project')
    vi.stubEnv('CLOUDSDK_CONFIG', decoyDir)
    vi.stubEnv('GCE_METADATA_HOST', metadataHost)
    // Express mode: a truthy GOOGLE_VERTEX_API_KEY would make the provider authenticate with
    // *this* key against a different base URL — which is why the factory passes `apiKey: ''`.
    vi.stubEnv('GOOGLE_VERTEX_API_KEY', 'decoy-express-mode-key')
    vi.stubEnv('GOOGLE_VERTEX_PROJECT', 'decoy-env-project')
    vi.stubEnv('GOOGLE_VERTEX_LOCATION', 'decoy-env-location')

    const requests: { url: string; headers: Record<string, string> }[] = []
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: urlOf(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    }

    const model = createProviderModelFactory({ vertexFetch: fetch })(
      'vertex/gemini-2.5-pro',
      CREDENTIAL,
    )
    const result = await streamModelRequest({ model, messages: [{ role: 'user', content: 'Hi' }] })

    // Nothing asked the metadata server for anything: no ADC probe, no instance token.
    expect(metadataRequests).toEqual([])
    // And no model request left the process — a decoy that had produced a token would have got
    // this far, carrying `Bearer decoy-metadata-token`.
    expect(requests).toEqual([])
    expect(result.error).toBeDefined()
    // What failed is the token exchange, with Google's own words for a well-formed assertion
    // for a service account that does not exist. Only the stored key can have produced it: the
    // decoy file is a different kind of credential, its project is not the one either client
    // was built with, and nothing else in the environment holds a private key.
    expect(String(result.error)).toMatch(/account not found|invalid_grant/i)
    expect(String(result.error)).not.toContain('decoy')
  }, 30_000)

  it('fails a malformed stored key locally, rather than reaching for any credential', async () => {
    // A document that parses but whose private key is not a key: the failure is the decoder,
    // raised while signing *with the stored document*. Nothing else can produce it — the decoy
    // file is never read, and the metadata server is never asked — so a bad stored key fails
    // instead of quietly becoming a working request under somebody else's credentials.
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', join(decoyDir, 'decoy-credentials.json'))
    vi.stubEnv('GCE_METADATA_HOST', metadataHost)
    vi.stubEnv('GOOGLE_VERTEX_API_KEY', 'decoy-express-mode-key')

    const requests: string[] = []
    const fetch = (input: RequestInfo | URL): Promise<Response> => {
      requests.push(urlOf(input))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }

    const model = createProviderModelFactory({ vertexFetch: fetch })('vertex/gemini-2.5-pro', {
      ...CREDENTIAL,
      serviceAccount: JSON.stringify({ ...SERVICE_ACCOUNT, private_key: 'not-a-pem' }),
    })
    const result = await streamModelRequest({ model, messages: [{ role: 'user', content: 'Hi' }] })

    expect(metadataRequests).toEqual([])
    expect(requests).toEqual([])
    expect(String(result.error)).toMatch(/DECODER routines|unsupported/i)
  }, 30_000)

  it('builds the fixed providers from an api_key credential exactly as before', () => {
    // The named path must not have changed the fixed one.
    expect(() =>
      providerModelFactory('anthropic/claude-haiku-4-5', {
        type: 'api_key',
        apiKey: 'sk-ant-test-key',
      }),
    ).not.toThrow()
  })
})
