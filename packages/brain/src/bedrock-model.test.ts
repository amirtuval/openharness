import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BEDROCK_INFERENCE_PROFILES_PATH,
  BEDROCK_SERVICE,
  bedrockControlPlaneUrl,
  bedrockRuntimeBaseUrl,
  signBedrockRequest,
} from './bedrock'
import {
  createProviderModelFactory,
  credentialSecrets,
  isUnsupportedProviderError,
  isUsableCredential,
  missingCredentialMessage,
  providerModelFactory,
  streamModelRequest,
  UnsupportedProviderError,
  type BedrockModelCredential,
} from './model'
import { TEST_API_KEY } from './testing/mock-model'

/**
 * Amazon Bedrock as a model client (epic #245, A3c).
 *
 * A Bedrock credential is a **named** credential: its name is the first half of the model id
 * (`bedrock/anthropic.claude-sonnet-4-20250514-v1:0`) and the Bedrock model id is the rest. It
 * carries no endpoint — the host is derived from the region — and it is a *credential type*
 * rather than one of the eleven provider ids, because one account may hold several, one per
 * region, each under a name the reader chose (`bedrock-us`).
 *
 * The rule these tests pin hardest is the A5 one: every request is signed with the **stored**
 * keys and with nothing from the environment. The decoys below are the variables an AWS SDK
 * would normally read — the two keys, the session token, `AWS_REGION`, `AWS_PROFILE`, a shared
 * credentials file, the two endpoint overrides the AI SDK honours, and the bearer-token variable
 * that would flip the whole client away from SigV4 — and every one of them has to be invisible
 * in the request that goes out.
 */

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDEXAMPLEtoken'

const CREDENTIAL: BedrockModelCredential = {
  type: 'bedrock',
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET_ACCESS_KEY,
  region: 'eu-west-1',
}

const PROMPT = [{ role: 'user' as const, content: 'Hello' }]

/** A captured request: where it went, and the headers it carried. */
interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * Run one streaming model request through the real factory, capturing what the provider sent.
 *
 * The provider uses `globalThis.fetch` when it was not handed one — `createProviderModelFactory`
 * has no Bedrock `fetch` seam, and does not need one, because a Bedrock host is derived from the
 * region rather than typed by a user — so the capture is a stubbed global, exactly the seam a
 * test of "what did the provider send" wants.
 */
async function captureRequest(
  modelId: string,
  credential: BedrockModelCredential = CREDENTIAL,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : '',
    })
    return Promise.resolve(
      new Response(JSON.stringify({ message: 'not under test' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  const model = providerModelFactory(modelId, credential)
  await streamModelRequest({ model, messages: PROMPT })
  return captured
}

/** Every decoy an AWS SDK could read, set the way a deployment might have them. */
function stubAwsDecoys(): { credentialsFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'openharness-aws-'))
  const credentialsFile = join(directory, 'credentials')
  writeFileSync(
    credentialsFile,
    [
      '[default]',
      'aws_access_key_id = AKIADECOYSHAREDFILE',
      'aws_secret_access_key = decoy-shared-secret',
      '',
    ].join('\n'),
  )
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIADECOYENVIRONMENT')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'decoy-environment-secret')
  vi.stubEnv('AWS_SESSION_TOKEN', 'decoy-environment-session-token')
  vi.stubEnv('AWS_REGION', 'ap-south-1')
  vi.stubEnv('AWS_DEFAULT_REGION', 'ap-south-1')
  vi.stubEnv('AWS_PROFILE', 'decoy-profile')
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentialsFile)
  vi.stubEnv('AWS_CONFIG_FILE', credentialsFile)
  vi.stubEnv('AWS_ENDPOINT_URL', 'https://decoy-endpoint.example')
  vi.stubEnv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'https://decoy-endpoint.example')
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'decoy-bearer-token')
  return { credentialsFile }
}

describe('the Bedrock endpoints', () => {
  it('builds both AWS hosts from the region, and only from it', () => {
    // One signing service for both hosts: AWS scopes a runtime request to `bedrock` too.
    expect(BEDROCK_SERVICE).toBe('bedrock')
    expect(bedrockRuntimeBaseUrl('us-east-1')).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com',
    )
    expect(bedrockRuntimeBaseUrl('eu-west-1')).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com',
    )
    expect(bedrockControlPlaneUrl('eu-west-1')).toBe('https://bedrock.eu-west-1.amazonaws.com')
    expect(bedrockControlPlaneUrl('eu-west-1', '/foundation-models')).toBe(
      'https://bedrock.eu-west-1.amazonaws.com/foundation-models',
    )
    // The second control-plane read the catalogue makes, on the same host (issue #274).
    expect(BEDROCK_INFERENCE_PROFILES_PATH).toBe('/inference-profiles')
    expect(bedrockControlPlaneUrl('eu-west-1', BEDROCK_INFERENCE_PROFILES_PATH)).toBe(
      'https://bedrock.eu-west-1.amazonaws.com/inference-profiles',
    )
  })
})

describe('createProviderModelFactory — the bedrock path', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no request expected')))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('sends the request to the region’s runtime host, with the model id from the model id', async () => {
    const requests = await captureRequest('bedrock/anthropic.claude-3-5-haiku-20241022-v1:0')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/' +
        'anthropic.claude-3-5-haiku-20241022-v1%3A0/converse-stream',
    )
    expect(requests[0]?.method).toBe('POST')
  })

  it('takes the credential name as the model prefix, whatever it is called', async () => {
    // A second Bedrock credential is `bedrock-us`, and its name is the left half of the id.
    const requests = await captureRequest('bedrock-us/anthropic.claude-3-5-haiku-20241022-v1:0')
    expect(requests).toHaveLength(1)
    // The model id keeps everything after the first slash, colon and all — percent-encoded by
    // the URL, as it is for every provider whose ids carry punctuation.
    expect(requests[0]?.url).toContain('/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/converse')
  })

  it('passes an inference profile id through as the model id (issue #274)', async () => {
    // A profile id is what AWS's Converse API takes in `modelId`, and the catalogue offers
    // `<credential name>/<inferenceProfileId>`. The factory does nothing to the second half but
    // URL-encode it, exactly as it does the on-demand id beside it.
    const requests = await captureRequest('bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/' +
        'us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream',
    )
  })

  it('passes an inference profile ARN through as the model id (issue #274)', async () => {
    // A profile may also be named by its ARN, which carries slashes and colons of its own: the
    // id is everything after the credential name's slash, and the provider percent-encodes the
    // whole of it into the Converse path — the shape AWS documents for an ARN.
    const arn =
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5'
    const requests = await captureRequest(`bedrock/${arn}`)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      `https://bedrock-runtime.eu-west-1.amazonaws.com/model/${encodeURIComponent(arn)}/converse-stream`,
    )
  })

  it('signs with the stored access key, and reads nothing from the environment', async () => {
    stubAwsDecoys()
    const requests = await captureRequest('bedrock/anthropic.claude-3-5-haiku-20241022-v1:0')
    expect(requests).toHaveLength(1)
    const request = requests[0] as CapturedRequest

    // The host is the credential's region, not the decoy `AWS_REGION` (ap-south-1).
    expect(new URL(request.url).host).toBe('bedrock-runtime.eu-west-1.amazonaws.com')

    // The signature names the stored access key and its region, and the request is SigV4 —
    // not the bearer-token path `AWS_BEARER_TOKEN_BEDROCK` would have turned the client onto.
    const authorization = request.headers.authorization ?? ''
    expect(authorization).toContain(`Credential=${ACCESS_KEY_ID}/`)
    expect(authorization).toContain('/eu-west-1/bedrock/aws4_request')
    expect(authorization.startsWith('AWS4-HMAC-SHA256 ')).toBe(true)
    expect(authorization).not.toContain('Bearer')

    // No decoy, in any header or in the body, under any name.
    const whole = JSON.stringify(request)
    for (const decoy of [
      'AKIADECOYENVIRONMENT',
      'decoy-environment-secret',
      'decoy-environment-session-token',
      'decoy-shared-secret',
      'AKIADECOYSHAREDFILE',
      'decoy-profile',
      'decoy-endpoint.example',
      'decoy-bearer-token',
    ]) {
      expect(whole, decoy).not.toContain(decoy)
    }
    // And no session token at all: the stored credential has none, and `AWS_SESSION_TOKEN`
    // does not stand in for one.
    expect(request.headers['x-amz-security-token']).toBeUndefined()
  })

  it('carries the stored session token when the credential has one', async () => {
    stubAwsDecoys()
    const requests = await captureRequest('bedrock/anthropic.claude-3-5-haiku-20241022-v1:0', {
      ...CREDENTIAL,
      sessionToken: SESSION_TOKEN,
    })
    const request = requests[0] as CapturedRequest
    expect(request.headers['x-amz-security-token']).toBe(SESSION_TOKEN)
    expect(JSON.stringify(request)).not.toContain('decoy-environment-session-token')
  })

  it('names the region of the credential, not the environment, in the signature', async () => {
    stubAwsDecoys()
    const requests = await captureRequest('bedrock/anthropic.claude-3-5-haiku-20241022-v1:0', {
      ...CREDENTIAL,
      region: 'us-west-2',
    })
    const request = requests[0] as CapturedRequest
    expect(new URL(request.url).host).toBe('bedrock-runtime.us-west-2.amazonaws.com')
    expect(request.headers.authorization ?? '').toContain('/us-west-2/bedrock/aws4_request')
  })
})

describe('signBedrockRequest', () => {
  it('signs a control-plane read with the stored keys, and reads nothing from the environment', async () => {
    stubAwsDecoys()
    const signed = await signBedrockRequest(
      CREDENTIAL,
      bedrockControlPlaneUrl('eu-west-1', '/foundation-models?byInferenceType=ON_DEMAND'),
    )

    expect(signed.method).toBe('GET')
    expect(new URL(signed.url).host).toBe('bedrock.eu-west-1.amazonaws.com')
    expect(signed.headers.authorization).toContain(`Credential=${ACCESS_KEY_ID}/`)
    // The scope's service is `bedrock` — the control plane's — and its region the credential's,
    // not the decoy `AWS_REGION` (ap-south-1).
    expect(signed.headers.authorization).toContain('/eu-west-1/bedrock/aws4_request')
    expect(signed.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
    // No decoy travelled with the signature, and no session token was invented.
    const whole = JSON.stringify(signed.headers)
    expect(whole).not.toContain('decoy')
    expect(signed.headers['x-amz-security-token']).toBeUndefined()
  })

  it('carries the stored session token, and signs a runtime URL for the same service', async () => {
    const signed = await signBedrockRequest(
      { ...CREDENTIAL, sessionToken: SESSION_TOKEN },
      bedrockRuntimeBaseUrl('eu-west-1'),
    )

    expect(new URL(signed.url).host).toBe('bedrock-runtime.eu-west-1.amazonaws.com')
    expect(signed.headers['x-amz-security-token']).toBe(SESSION_TOKEN)
    // A runtime host is still signed for the `bedrock` service, exactly as the provider does.
    expect(signed.headers.authorization).toContain('/eu-west-1/bedrock/aws4_request')
  })

  it('signs the method and headers it was given, and nothing else', async () => {
    const signed = await signBedrockRequest(CREDENTIAL, bedrockControlPlaneUrl('us-east-1'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(signed.method).toBe('POST')
    expect(signed.headers['content-type']).toBe('application/json')
    // The signed header list is the one the signature covers, host and date included.
    expect(signed.headers.authorization).toContain('SignedHeaders=')
  })
})

describe('the bedrock credential rules', () => {
  it('refuses a credential missing either key or the region, and accepts one with all three', () => {
    expect(isUsableCredential({ ...CREDENTIAL, accessKeyId: '' })).toBe(false)
    expect(isUsableCredential({ ...CREDENTIAL, accessKeyId: '   ' })).toBe(false)
    expect(isUsableCredential({ ...CREDENTIAL, secretAccessKey: '' })).toBe(false)
    expect(isUsableCredential({ ...CREDENTIAL, region: '' })).toBe(false)
    expect(isUsableCredential(CREDENTIAL)).toBe(true)
    // A session token is genuinely optional — a long-lived IAM user key has none.
    expect(isUsableCredential({ ...CREDENTIAL, sessionToken: undefined })).toBe(true)
    expect(isUsableCredential(null)).toBe(false)
  })

  it('lists every secret the credential carries, for redaction', () => {
    expect(credentialSecrets(CREDENTIAL)).toEqual([ACCESS_KEY_ID, SECRET_ACCESS_KEY])
    expect(credentialSecrets({ ...CREDENTIAL, sessionToken: SESSION_TOKEN })).toEqual([
      ACCESS_KEY_ID,
      SECRET_ACCESS_KEY,
      SESSION_TOKEN,
    ])
    // The other types are unchanged: one key, and an Azure endpoint is not a secret.
    expect(credentialSecrets({ type: 'api_key', apiKey: TEST_API_KEY })).toEqual([TEST_API_KEY])
    expect(
      credentialSecrets({ type: 'azure_openai', apiKey: 'az', endpoint: 'https://x.example' }),
    ).toEqual(['az'])
  })

  it('names the default credential of the type the way its type is called', () => {
    expect(missingCredentialMessage('bedrock')).toBe(
      'No Amazon Bedrock key is set. Add one in Settings → Model providers.',
    )
    // A second credential's own name falls back to itself, capitalised.
    expect(missingCredentialMessage('bedrock-us')).toBe(
      'No Bedrock-us key is set. Add one in Settings → Model providers.',
    )
  })

  it('refuses an id naming a provider with no client, before any request', () => {
    // A named credential's name is free text, so an unknown first half builds a Bedrock client
    // (like an Azure one) when the credential says so; it is the *key* that has no client.
    expect(() =>
      providerModelFactory('nobody/model', { type: 'api_key', apiKey: TEST_API_KEY }),
    ).toThrow(UnsupportedProviderError)
    expect(isUnsupportedProviderError(new UnsupportedProviderError('nobody'))).toBe(true)
  })

  it('still builds the eleven fixed providers from an api_key credential', () => {
    expect(() =>
      providerModelFactory('anthropic/claude-haiku-4-5', {
        type: 'api_key',
        apiKey: TEST_API_KEY,
      }),
    ).not.toThrow()
    // A credential type that does not belong to a fixed provider id cannot build one.
    expect(() => createProviderModelFactory()('anthropic/claude-haiku-4-5', CREDENTIAL)).toThrow(
      UnsupportedProviderError,
    )
  })
})
