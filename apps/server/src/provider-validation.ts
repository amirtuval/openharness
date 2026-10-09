/**
 * Validating a provider credential with one cheap provider call (epic #65, A5; Azure: epic
 * #245 A3a; Bedrock: A3c).
 *
 * A credential is checked on save: the server makes one cheap, authenticated call and stores
 * nothing unless it succeeds. Which call is a function of the credential's **type** —
 *
 * - `api_key`: one page of the provider's own model list (or an equivalent cheap read), the
 *   same call the model catalogue makes (C1);
 * - `azure_openai`: one chat request to the first deployment the user typed, sent through the
 *   SSRF guard (`@openharness/hands`' `safeFetch`), because the endpoint is a URL the user
 *   typed and Azure offers no endpoint that lists deployments.
 * - `openai_compatible`: one `GET {base_url}/models`, the same call the catalogue makes, sent
 *   through `safeFetch` — the base URL is the user's, and the answer both proves the endpoint
 *   (and key) and is exactly the list the credential will contribute.
 * - `bedrock`: one `ListFoundationModels` read in the credential's region, SigV4-signed with the
 *   user's keys. The host is derived from the region — there is no user-supplied URL and so
 *   nothing for a guard to check — and the region itself was validated against the protocol's
 *   list before this ran.
 *
 * The check is a real request to the provider, which is exactly why it is a seam
 * (`ProviderCredentialValidator`) the server's tests inject a fake into: no test should reach
 * a provider, and no test should need a real key.
 *
 * The validator never logs, echoes or includes a secret in an error message: a rejected
 * credential answers with the provider's status — and, for AWS, its own reason, scrubbed — not
 * with what was sent.
 *
 * The `api_key` call goes through the provider HTTP client the model catalogue uses
 * (`catalog/provider-fetch.ts`): the one outbound path that honors the egress-proxy variables
 * a deployment sets, so saving a key works behind a proxy exactly as listing models does. An
 * Azure endpoint goes through `safeFetch`, which reads the same variables (see that module)
 * and additionally refuses every address a user-supplied URL must not reach. A Bedrock read
 * signs first and then goes through the same provider HTTP client as `api_key`, and a Vertex
 * read signs its own token and does the same.
 */

import {
  SAVE_TIME_LIMITS,
  safeFetch as defaultSafeFetch,
  type SafeFetchOptions,
} from '@openharness/hands'
import {
  BEDROCK_FOUNDATION_MODELS_PATH,
  azureBaseUrl,
  bedrockControlPlaneUrl,
  openAICompatibleBaseUrl,
  redactSecrets,
  signBedrockRequest,
} from '@openharness/brain'
import {
  PROVIDER_IDS,
  type ProviderId,
  type PutProviderCredentialRequest,
} from '@openharness/protocol'

import {
  createProviderFetch,
  errorSnippet,
  type ProviderFetch,
  type ProviderResponse,
} from './catalog/provider-fetch'
import { vertexPublisherModelsUrl, vertexTokenProvider, type VertexTokenProvider } from './vertex'
import { vertexPublisherModelsUrl, vertexTokenProvider, type VertexTokenProvider } from './vertex'

/** The provider HTTP client, built once: one outbound path for validation and listing. */
const providerFetch: ProviderFetch = createProviderFetch()

/**
 * The providers the server can validate an `api_key` for — the `provider/model` provider ids
 * whose one-key providers have a cheap authenticated read. The protocol stores any provider
 * string; a key for one outside this set is refused on save because it cannot be validated,
 * rather than stored unchecked.
 *
 * The set is the shared provider list's (`@openharness/protocol`): every provider openharness
 * knows has a cheap read here, a model-list adapter in `catalog/adapters.ts` and a model client
 * in the brain. That used to be three tables and a test; since #245 each table is typed against
 * `ProviderId`, so a provider missing from one is a compile error rather than a failure here.
 */
export const VALIDATABLE_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS

/** A provider id {@link VALIDATABLE_PROVIDERS} knows. */
export type ValidatableProvider = ProviderId

/**
 * Checks that a credential authenticates against its provider; throws when it does not.
 *
 * The name is the credential's name — its provider id for the eleven fixed providers, a name
 * the user chose for a named type — and the body is the whole PUT payload, because what a
 * check needs differs by type.
 */
export type ProviderCredentialValidator = (
  name: string,
  body: PutProviderCredentialRequest,
) => Promise<void>

/** How long the validating call may take before it counts as a failure. */
const VALIDATION_TIMEOUT_MS = 10_000

/**
 * The `safeFetch` shape the URL-typed checks use — an Azure endpoint, or a custom
 * OpenAI-compatible base URL. Injectable so a route test can drive a stub.
 */
export type ProviderValidatorFetch = (
  url: string,
  init?: RequestInit,
  options?: SafeFetchOptions,
) => Promise<Response>

/** What a validator needs: the outbound paths, the self-host flag, and how a Vertex token is obtained. */
export interface ProviderCredentialValidatorOptions {
  /** The provider HTTP client the `api_key`, Bedrock and Vertex reads go through. Defaults to the
   * egress-proxy one. */
  readonly providerFetch?: ProviderFetch
  /** The guard an Azure or custom check goes through. Defaults to `@openharness/hands`' `safeFetch`. */
  readonly safeFetch?: ProviderValidatorFetch
  /**
   * `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`: whether a **custom OpenAI-compatible** endpoint
   * may reach a private address (epic #245, M4). Off by default. It is read here, on save,
   * exactly as it is on the model call and the `/models` listing — every path into a
   * user-supplied URL checks the address, so a private endpoint is refused before it can be
   * stored and again on every request after. It never applies to an Azure endpoint.
   */
  readonly allowPrivateProviderUrls?: boolean
  /** How a Vertex service account becomes an OAuth token. Defaults to the Google signing one. */
  readonly vertexToken?: VertexTokenProvider
}

/**
 * The production validator: the one cheap call a saved credential is checked with.
 *
 * A non-2xx answer, a transport failure or a timeout all throw — the caller turns that into
 * the protocol's 422 `invalid_provider_credential`. The error's message names the credential
 * and the status, never the secret.
 */
export function createProviderCredentialValidator(
  options: ProviderCredentialValidatorOptions = {},
): ProviderCredentialValidator {
  const fetch = options.providerFetch ?? providerFetch
  const guard = options.safeFetch ?? defaultSafeFetch
  const allowPrivate = options.allowPrivateProviderUrls === true
  const vertexToken = options.vertexToken ?? vertexTokenProvider
  return async (name, body) => {
    if (body.type === 'azure_openai') {
      return validateAzureCredential(name, body, guard)
    }
    if (body.type === 'openai_compatible') {
      return validateOpenAICompatibleCredential(name, body, guard, allowPrivate)
    }
    if (body.type === 'bedrock') {
      return validateBedrockCredential(name, body, fetch)
    }
    if (body.type === 'vertex') {
      return validateVertexCredential(name, body, vertexToken, fetch)
    }
    return validateApiKey(name, body.api_key, fetch)
  }
}

/** The validator the server runs unless a host injects one. */
export const validateProviderCredential: ProviderCredentialValidator =
  createProviderCredentialValidator()

/** One authenticated `GET` of a provider's own model list, proving an `api_key`. */
async function validateApiKey(name: string, apiKey: string, fetch: ProviderFetch): Promise<void> {
  const request = requestFor(name, apiKey)
  if (request === null) {
    throw new Error(
      `no validation for provider ${JSON.stringify(name)}; supported: ` +
        VALIDATABLE_PROVIDERS.join(', '),
    )
  }
  let response: ProviderResponse
  try {
    response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `could not reach ${name} to validate the key: ` +
        (error instanceof Error ? error.message : 'the request failed'),
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(
      `${name} answered ${response.status} for the validating request; the key was rejected`,
    )
  }
  // The body is drained so the connection can be reused; nothing in it is read or stored.
  await response.text()
}

/**
 * One chat request to the first deployment an Azure credential names, proving its key.
 *
 * The request is deliberately tiny — one token of output, no streaming — and it goes through
 * `safeFetch` under {@link SAVE_TIME_LIMITS}: ten seconds, at most a megabyte, and the address
 * checks that refuse a loopback, private or metadata endpoint. That last part is the point: an
 * endpoint that resolves inside the network is refused **here**, on save, so it can never be
 * stored and later reached from the model path.
 */
async function validateAzureCredential(
  name: string,
  body: Extract<PutProviderCredentialRequest, { type: 'azure_openai' }>,
  safeFetch: ProviderValidatorFetch,
): Promise<void> {
  const deployment = body.deployments[0] as string
  const url =
    `${azureBaseUrl(body.endpoint)}/v1/chat/completions?api-version=` +
    encodeURIComponent(AZURE_API_VERSION)
  let response: Response
  try {
    response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: { 'api-key': body.api_key, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: 1,
          stream: false,
        }),
      },
      SAVE_TIME_LIMITS,
    )
  } catch (error) {
    throw new Error(
      `could not reach ${name} to validate the credential: ` +
        (error instanceof Error ? error.message : 'the request failed'),
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(
      `the deployment ${deployment} on ${hostOf(body.endpoint)} answered ` +
        `${response.status} for the validating request; the credential was rejected`,
    )
  }
  // The body is drained so the connection can be released; nothing in it is read or stored.
  await response.text()
}

/**
 * One `GET {base}/models` at a custom OpenAI-compatible endpoint, proving its key — or, for a
 * keyless endpoint, that it answers at all (epic #245, A3b).
 *
 * The check is the same call the model catalogue makes, and it is the whole save-time contract
 * for this type: a non-2xx answer, a transport failure or a timeout all refuse the credential.
 * It goes through `safeFetch` under {@link SAVE_TIME_LIMITS}, so a loopback, private or
 * metadata endpoint is refused **here**, before the credential can be stored — unless the
 * server's self-host setting (`allowPrivate`) turned that refusal off, which is the only
 * difference from Azure's check. The key, when there is one, is sent as a bearer token exactly
 * as the model call sends it; a keyless endpoint is asked with no `Authorization` header.
 */
async function validateOpenAICompatibleCredential(
  name: string,
  body: Extract<PutProviderCredentialRequest, { type: 'openai_compatible' }>,
  safeFetch: ProviderValidatorFetch,
  allowPrivate: boolean,
): Promise<void> {
  const url = `${openAICompatibleBaseUrl(body.base_url)}/models`
  const headers: Record<string, string> =
    body.api_key === undefined ? {} : { authorization: `Bearer ${body.api_key}` }
  let response: Response
  try {
    response = await safeFetch(
      url,
      { method: 'GET', headers },
      { ...SAVE_TIME_LIMITS, allowPrivate },
    )
  } catch (error) {
    throw new Error(
      `could not reach ${name} to validate the credential: ` +
        (error instanceof Error ? error.message : 'the request failed'),
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(
      `the endpoint ${hostOf(body.base_url)} answered ${response.status} for the validating ` +
        'request; the credential was rejected',
    )
  }
  // The body is drained so the connection can be released; nothing in it is read or stored.
  await response.text()
}

/**
 * One `ListFoundationModels` read in the credential's region, proving the access keys (epic
 * #245, A3c).
 *
 * This is the control plane — `bedrock.<region>.amazonaws.com` — not the runtime the model
 * requests go to: `ListFoundationModels` is what tells whether the keys and the region work
 * together, it answers in a page of small JSON rather than a model call, and it is the same
 * call the catalogue makes, so a credential that saves can also list. AWS's own reason for a
 * refusal is what the caller sees ("the security token included in the request is invalid"),
 * scrubbed of every secret before it is, because the message travels into a 422 body.
 *
 * The request is SigV4-signed by `@openharness/brain` (the same `aws4fetch` signer the model
 * path's provider package uses) and sent through the server's provider client, so a Bedrock
 * check reaches AWS the way every other provider call does, egress proxy included.
 *
 * There is **no SSRF guard here and none is needed**: the host is derived from the region, and
 * the region was validated against the protocol's list of Bedrock regions before this ran, so
 * there is no user-supplied address for a guard to check.
 */
async function validateBedrockCredential(
  name: string,
  body: Extract<PutProviderCredentialRequest, { type: 'bedrock' }>,
  fetch: ProviderFetch,
): Promise<void> {
  const secrets = [body.access_key_id, body.secret_access_key, body.session_token]
  const signed = await signBedrockRequest(
    {
      type: 'bedrock',
      accessKeyId: body.access_key_id,
      secretAccessKey: body.secret_access_key,
      ...(body.session_token === undefined ? {} : { sessionToken: body.session_token }),
      region: body.region,
    },
    bedrockControlPlaneUrl(body.region, BEDROCK_FOUNDATION_MODELS_PATH),
  )
  let response: ProviderResponse
  try {
    response = await fetch(signed.url, {
      headers: signed.headers,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `could not reach Bedrock in ${body.region} to validate the credential: ` +
        (error instanceof Error ? error.message : 'the request failed'),
      { cause: error },
    )
  }
  if (!response.ok) {
    // AWS's reason, bounded and scrubbed: it names what was wrong with the request (an invalid
    // key, a region the principal cannot use) without ever echoing a secret.
    const reason = redactSecrets(await awsReason(response), secrets)
    throw new Error(
      `Bedrock in ${body.region} answered ${response.status} for ListFoundationModels` +
        (reason === '' ? '; the credential was rejected' : `: ${reason}`),
    )
  }
  // The body is drained so the connection can be released; the model list it carries is the
  // catalogue's to read, not this call's.
  await response.text()
}

/** How much of AWS's own message an error carries. */
const AWS_REASON_LIMIT = 200

/**
 * AWS's reason for a refusal, from either envelope it uses.
 *
 * The JSON protocol answers `{ message }`, and the query-ish protocol around it `{ Message }`;
 * a body that is neither (an XML error, an HTML proxy page) is passed through as trimmed text,
 * so a refusal always says something rather than nothing.
 */
async function awsReason(response: ProviderResponse): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return ''
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      for (const key of ['message', 'Message']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') {
          return value.trim().slice(0, AWS_REASON_LIMIT)
        }
      }
    }
  } catch {
    // Not JSON: fall through to the trimmed text below.
  }
  return body.trim().replace(/\s+/g, ' ').slice(0, AWS_REASON_LIMIT)
}

/** The api-version the validating call uses: Azure's current `v1` API, what the model path uses. */
const AZURE_API_VERSION = 'v1'

/**
 * One authenticated read of the project's publisher models, proving a Vertex credential.
 *
 * The token is obtained **from the stored service account** (see `vertex.ts`) and attached as
 * a bearer, and the call is Google's own `publishers.google.models.list` for the credential's
 * project and location: one page, one model. It is the smallest call that proves all three
 * things a Vertex credential has to be right about — the key, the project, and the location —
 * and it fails with Google's reason rather than a generic one when the Vertex AI API is not
 * enabled for the project, which is the misconfiguration a perfectly good key usually meets.
 *
 * The endpoint is Google's, derived from the validated location, so unlike Azure's it needs no
 * SSRF guard: there is no URL here a user typed. The call goes through the same egress-proxy
 * HTTP client every other provider call does.
 */
async function validateVertexCredential(
  name: string,
  body: Extract<PutProviderCredentialRequest, { type: 'vertex' }>,
  token: VertexTokenProvider,
  fetch: ProviderFetch,
): Promise<void> {
  let accessToken: string
  try {
    accessToken = await token(body.service_account)
  } catch (error) {
    throw new Error(
      `could not authenticate ${name} against Google: ` +
        (error instanceof Error ? error.message : 'the token request failed'),
      { cause: error },
    )
  }
  const url = vertexPublisherModelsUrl({ project: body.project, location: body.location })
  let response: ProviderResponse
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `could not reach Vertex to validate the credential: ` +
        (error instanceof Error ? error.message : 'the request failed'),
      { cause: error },
    )
  }
  if (!response.ok) {
    // Google's own sentence, kept (it names the API to enable, the project, the region), and
    // bounded like the catalogue's fallback messages: a provider's error body is not a place
    // to read a whole page from.
    throw new Error(
      `Vertex answered ${response.status} for the project ${body.project} in ` +
        `${body.location}${await errorSnippet(response)}`,
    )
  }
  // The body is drained so the connection can be reused; nothing in it is read or stored.
  await response.text()
}

/** The host of an endpoint, for an error message that does not echo a whole URL. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** The one cheap, authenticated read that proves a key: `GET <url>` with these headers. */
interface ValidationRequest {
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * The validating request per provider, as a table typed against the shared list (#245): a
 * provider with no request is a compile error, not a key that silently cannot be saved.
 *
 * Every entry is a constant: the URL never comes from a request, so a key can only be sent to
 * the provider it was stored for.
 */
const VALIDATION_REQUESTS: Readonly<Record<ProviderId, (apiKey: string) => ValidationRequest>> = {
  anthropic: (apiKey) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  }),
  openai: (apiKey) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  google: (apiKey) => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': apiKey },
  }),
  // The key's own metadata: the cheapest authenticated call OpenRouter answers.
  openrouter: (apiKey) => ({
    url: 'https://openrouter.ai/api/v1/key',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  groq: (apiKey) => ({
    url: 'https://api.groq.com/openai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  deepseek: (apiKey) => ({
    url: 'https://api.deepseek.com/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  fireworks: (apiKey) => ({
    url: 'https://api.fireworks.ai/inference/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  mistral: (apiKey) => ({
    url: 'https://api.mistral.ai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  together: (apiKey) => ({
    url: 'https://api.together.xyz/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  xai: (apiKey) => ({
    url: 'https://api.x.ai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  cerebras: (apiKey) => ({
    url: 'https://api.cerebras.ai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
}

/**
 * The request that validates a key for `provider`, or `null` for a provider the table has no
 * entry for — a provider the server refuses on save rather than storing unchecked. The lookup
 * is `Object.hasOwn` rather than a bare index so a provider string that names an inherited
 * property (`toString`, `constructor`) is a miss, not a function call.
 */
function requestFor(provider: string, apiKey: string): ValidationRequest | null {
  if (!Object.hasOwn(VALIDATION_REQUESTS, provider)) {
    return null
  }
  return VALIDATION_REQUESTS[provider as ProviderId](apiKey)
}
