import {
  PROVIDERS as SHARED_PROVIDERS,
  PROVIDER_IDS,
  CREDENTIAL_TYPES,
  type ModelUsage,
  type ProviderId,
} from '@openharness/protocol'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAzure } from '@ai-sdk/azure'
import { createCerebras } from '@ai-sdk/cerebras'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createFireworks } from '@ai-sdk/fireworks'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createVertex } from '@ai-sdk/google-vertex'
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createXai } from '@ai-sdk/xai'
import type { LanguageModel, ModelMessage } from 'ai'
import { streamText } from 'ai'

import { azureBaseUrl, azureFetch } from './azure-fetch'
import { bedrockRuntimeBaseUrl } from './bedrock'
import { isOwnershipError } from './errors'
import { openAICompatibleBaseUrl, openAICompatibleFetch } from './openai-compatible-fetch'
import type { ProviderFetch } from './provider-fetch'
import { isVertexAnthropicModel } from './vertex'

/**
 * Making a model request, and the seam that keeps the brain testable.
 *
 * The brain never reads a provider credential from the environment: the credential is handed
 * to it per request (see {@link ResolveCredential}, epic #65 A5), and it passes it to a
 * {@link ModelFactory} together with the id the session carries (`provider/model`, what the
 * protocol calls a model id). Streaming happens through {@link streamModelRequest}. A test
 * injects a factory that hands back one of the AI SDK's mock models, so the whole turn loop
 * runs with no API keys and no network.
 */

/**
 * The credential one model request is made with — the session owner's own provider credential.
 *
 * It is held for exactly one request: the turn resolves it before the request, builds the
 * model with it, and lets it go when the request ends. The `type` says which shape the rest of
 * it has, and it is what lets a `provider/model` id name either one of the eleven fixed
 * providers or a named credential of a different type (epic #245, A3a) — the server resolves
 * the model id's first half to a stored credential, and its type is what the factory builds
 * with.
 */
export type ModelCredential =
  | ApiKeyModelCredential
  | AzureOpenAIModelCredential
  | OpenAICompatibleModelCredential
  | BedrockModelCredential
  | VertexModelCredential

/** An `api_key` credential: a single secret, passed to one of the eleven provider clients. */
export interface ApiKeyModelCredential {
  readonly type: 'api_key'
  /** The provider's API key. Passed to the provider explicitly; never read from the environment. */
  readonly apiKey: string
}

/**
 * An `azure_openai` credential: the resource endpoint and the key that authenticates it.
 *
 * The deployment is not here — it is the model id's second half (`azure/gpt-4o` names the
 * deployment `gpt-4o` on the `azure` credential) — because one credential serves every
 * deployment it was saved with.
 */
export interface AzureOpenAIModelCredential {
  readonly type: 'azure_openai'
  /** The Azure OpenAI API key. Passed to the provider explicitly; never read from the environment. */
  readonly apiKey: string
  /**
   * The resource endpoint the user saved, e.g. `https://my-resource.openai.azure.com`. The
   * base URL `@ai-sdk/azure` needs is derived from it by {@link azureBaseUrl}.
   */
  readonly endpoint: string
}

/**
 * An `openai_compatible` credential: a base URL a user chose, and the key that authenticates
 * it — if the endpoint wants one (epic #245, A3b).
 *
 * The model is the id's second half (`custom/llama3.3` names the model `llama3.3` on the
 * `custom` credential), the same shape an Azure deployment takes, because one credential
 * serves every model its endpoint lists.
 */
export interface OpenAICompatibleModelCredential {
  readonly type: 'openai_compatible'
  /** The API key, or `''` when the endpoint takes none (a local server, say). */
  readonly apiKey: string
  /**
   * The OpenAI-compatible API root the user saved, e.g. `http://127.0.0.1:11434/v1`. Passed to
   * `@ai-sdk/openai-compatible` as-is, normalized by {@link openAICompatibleBaseUrl}.
   */
  readonly baseUrl: string
}

/**
 * A `bedrock` credential: an IAM principal's static access keys, and the region they act in
 * (epic #245, A3c).
 *
 * The model id is not here — it is the model id's second half (`bedrock/anthropic.claude-…-v1:0`
 * names a Bedrock model on the `bedrock` credential) — and neither is an endpoint: Bedrock's
 * hosts are derived from the region by `./bedrock.ts`. There is no assume-role in v1 (epic
 * #245, decision M4): these are static keys, and the save-time check is what proves them.
 */
export interface BedrockModelCredential {
  readonly type: 'bedrock'
  /** The IAM access key ID. Passed to the provider explicitly; never read from the environment. */
  readonly accessKeyId: string
  /** The IAM secret access key. Passed explicitly; never read from the environment. */
  readonly secretAccessKey: string
  /** The session token temporary credentials carry, when the principal has one. */
  readonly sessionToken?: string
  /**
   * The AWS region the credential acts in, validated against the protocol's list of the
   * regions AWS serves Bedrock in. Both the runtime host and the signature use it.
   */
  readonly region: string
}

/**
 * Every secret a credential carries, in the order a redactor should scrub them.
 *
 * `redactSecret` takes one secret, and a credential stopped being a single string when Bedrock
 * arrived: an AWS credential is an access key ID **and** a secret access key, plus a session
 * token when the principal has one, and a provider that echoes a rejected request back can echo
 * any of them. A Vertex credential is one document whose sensitive half is the PEM inside it
 * (#251) — the rest of the document is metadata a reader may see. Which strings are secret is a
 * property of the credential type, so it is stated here, beside the types, and every path that
 * scrubs (the turn's error text) asks this rather than reaching for a field that only one type
 * has.
 *
 * An Azure credential's endpoint is deliberately not in the list: it is a URL the user typed,
 * it rides on the credential's `details` in an API response, and it is not a secret.
 */
export function credentialSecrets(credential: ModelCredential): readonly string[] {
  if (credential.type === 'bedrock') {
    return [
      credential.accessKeyId,
      credential.secretAccessKey,
      ...(credential.sessionToken === undefined ? [] : [credential.sessionToken]),
    ]
  }
  if (credential.type === 'vertex') {
    const secret = vertexPrivateKey(credential.serviceAccount)
    return secret === '' ? [] : [secret]
  }
  return [credential.apiKey]
}

/**
 * A `vertex` credential: a Google Cloud service-account key, and the project and location it
 * runs in (epic #245, A3d).
 *
 * The model is not here — it is the model id's second half (`vertex/gemini-2.5-pro`) — and
 * neither is the endpoint: the host is derived from the location, which the protocol validates
 * against Google's published list.
 *
 * `serviceAccount` is the key document **as text**, the whole thing a user downloaded from the
 * console. It is parsed once, here, and handed to the client library as the credentials it
 * signs an OAuth token with — so this credential type carries the private key, and everything
 * that reads one of these must treat it as a secret (never logged, never echoed in an error).
 */
export interface VertexModelCredential {
  readonly type: 'vertex'
  /** The Google Cloud project the models run in. */
  readonly project: string
  /** The Vertex AI location, e.g. `us-central1`; the host is derived from it. */
  readonly location: string
  /** The service-account key document, as Google's console issued it. Never read from disk. */
  readonly serviceAccount: string
}

/**
 * Where the credential for one model request comes from.
 *
 * Called once per model request with the provider — the part of the session's
 * `model.id` before the slash, as {@link providerOf} reads it — and awaited before the
 * request is made. A host supplies it (the server decodes the session owner's stored
 * credential; #61); `null` means the owner has none for that provider, and the request is then
 * never attempted: the turn ends with a non-retryable `missing_provider_credential` error
 * instead of falling back to a key of its own.
 */
export type ResolveCredential = (provider: string) => Promise<ModelCredential | null>

/**
 * The model for a session's `model.id`, made with the credential the request runs under.
 *
 * The default is {@link providerModelFactory}, which resolves the `provider/model` id the
 * protocol stores. A host that wants its own provider setup — a different gateway, a fixed
 * model, a fake in a test — passes its own factory instead; a factory that needs no credential
 * (a mock model) ignores the second argument.
 */
export type ModelFactory = (modelId: string, credential: ModelCredential) => LanguageModel

/**
 * Per-provider options for one model request: what a provider's own client reads, keyed by the
 * name that client looks itself up under (`anthropic`, `openai`, `openaiCompatible`, …).
 *
 * Read off `streamText`'s own call options rather than imported from the AI SDK's provider
 * package, which this package does not depend on: what the loop hands over is exactly what the
 * call takes, whatever the SDK version calls the shape.
 */
export type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/** What one provider is: where its API lives, and how a client for it is built. */
interface ProviderClient {
  /**
   * The provider's API base URL, pinned.
   *
   * Every AI SDK provider has a `*_BASE_URL` environment variable it falls back to when a
   * constructor options object leaves the setting out, and a request built from the environment
   * is exactly what epic #65 (A5) forbids: a deployment could redirect — an endpoint, and with
   * it a key — to somewhere nobody chose. So the URL is passed explicitly here, in the one
   * place a `provider/model` becomes a client, and the environment cannot move a request at
   * all. The values are the providers' own defaults, which is what the router these replace
   * resolved too (the mapping is in the pull request for #234).
   */
  readonly baseURL: string
  /**
   * The client's model constructor, given the request's key, the pinned base URL and the
   * `fetch` every request is made through. Two of these are the Responses API rather than the
   * chat one (see {@link providerModelFactory}); otherwise this is the provider package's own
   * factory function, and the options are handed to it whole — so a package that reads
   * `fetch`, `baseURL` or `apiKey` sees exactly the one setting this table passed.
   */
  readonly model: (options: {
    readonly apiKey: string
    readonly baseURL: string
    /**
     * The `fetch` the request is made through, when the host injected one (an
     * egress-proxy-aware client, say). Left out entirely when there is none, so the provider
     * package falls back to the platform's `fetch` rather than to a setting of `undefined`.
     */
    readonly fetch?: ProviderFetch
  }) => (id: string) => LanguageModel
}

/**
 * The providers a `provider/model` id may name, and the client each one is built with, keyed
 * by the shared provider id (`@openharness/protocol`, epic #245).
 *
 * The table used to be the brain's own copy of the server's list, held in step by a test in
 * `apps/server`; now it is typed against `ProviderId`, so a provider a key can be saved for
 * and a request cannot be made to is a compile error here rather than a test failure there.
 */
const PROVIDER_CLIENTS: Readonly<Record<ProviderId, ProviderClient>> = {
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
    model: (options) => createAnthropic(options),
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: (options) => (id) => createOpenAI(options).responses(id),
  },
  google: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    model: (options) => createGoogleGenerativeAI(options),
  },
  // OpenRouter has no first-party AI SDK package in this tree; `@ai-sdk/openai-compatible` at
  // OpenRouter's base URL is the official package for exactly this API, says the same thing to
  // OpenRouter that the old router's bundled client did, and is already a dependency of the
  // Fireworks, Together and Cerebras clients below.
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: (options) => (id) =>
      createOpenAICompatible({ name: 'openrouter', ...options }).chatModel(id),
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: (options) => createGroq(options),
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    model: (options) => createDeepSeek(options),
  },
  fireworks: {
    baseURL: 'https://api.fireworks.ai/inference/v1',
    model: (options) => createFireworks(options),
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    model: (options) => createMistral(options),
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    model: (options) => createTogetherAI(options),
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    model: (options) => (id) => createXai(options).responses(id),
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    model: (options) => createCerebras(options),
  },
}

/**
 * Every provider id {@link providerModelFactory} can build a model for, in table order.
 *
 * The shared list's ids (`@openharness/protocol`), which are the same ones the server stores a
 * key for and the frontends offer. Exported so a host can check its own list against it rather
 * than restate it.
 */
export const SUPPORTED_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS

/** The model client for a provider id, or `undefined` for one this build has none for. */
function providerClientFor(provider: string): ProviderClient | undefined {
  // `Object.hasOwn`, not a bare index: a `provider/model` whose first half names an inherited
  // property (`toString`, `constructor`) is an unsupported provider, not a client.
  return Object.hasOwn(PROVIDER_CLIENTS, provider)
    ? PROVIDER_CLIENTS[provider as ProviderId]
    : undefined
}

/**
 * A `provider/model` id naming a provider this build has no client for.
 *
 * A provider outside {@link PROVIDER_CLIENTS} cannot have a credential stored (the server
 * refuses one it cannot validate), so the only way here is a session whose `model.id` names a
 * provider nobody configured — and the turn ends on it at the request boundary, the way a
 * missing credential does, rather than reaching a provider it could not authenticate to.
 */
export class UnsupportedProviderError extends Error {
  /** The provider id, as {@link providerOf} read it. */
  readonly provider: string

  constructor(provider: string) {
    super(
      `no model client for provider ${JSON.stringify(provider)}; supported: ` +
        SUPPORTED_PROVIDERS.join(', '),
    )
    this.name = 'UnsupportedProviderError'
    this.provider = provider
  }
}

/**
 * Whether `value` is the {@link UnsupportedProviderError} this module raises.
 *
 * `instanceof` first, then the stable `name`, the same way `errors.ts` recognises a store
 * error: the class is raised here and caught by the turn loop, but a second copy of this
 * package would throw its own.
 */
export function isUnsupportedProviderError(value: unknown): value is UnsupportedProviderError {
  if (value instanceof UnsupportedProviderError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate: Partial<UnsupportedProviderError> = value
  return candidate.name === 'UnsupportedProviderError' && typeof candidate.provider === 'string'
}

/**
 * What {@link createProviderModelFactory} takes: the seams a test replaces.
 *
 * The `fetch` an Azure model is built with is the SSRF guard (`@openharness/hands`'
 * `safeFetch`, `./azure-fetch.ts`). A host that injects its own factory — the server puts this
 * one behind its mock switch — does not need to override it; a test that wants to watch the
 * request the guard allows does.
 */
export interface ProviderModelFactoryOptions {
  /**
   * The `fetch` every request to one of the **eleven fixed providers** goes through.
   *
   * Their URLs are constants this table pins, so there is no user-typed address to guard — but
   * there is still an egress path, and a deployment that reaches the internet only through a
   * proxy sets `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` for it (#270). The provider packages fall
   * back to the platform's `fetch`, which ignores those variables unless the process was
   * started with `NODE_USE_ENV_PROXY=1` — so the host injects the egress-aware client here, the
   * same one the server's catalogue and credential checks already use, and a proxied
   * deployment can chat as well as list models. It is built **without** the catalogue's 5 s
   * deadline: a model streams a long reply, so a request-level timeout would cut it off.
   *
   * Defaults to the platform's `fetch` (nothing injected), which is what a host with a direct
   * egress path — and every test that stubs the global `fetch` — wants.
   */
  readonly fetch?: ProviderFetch
  /** The `fetch` every Azure OpenAI request goes through. Defaults to the safeFetch guard. */
  readonly azureFetch?: ProviderFetch
  /**
   * The `fetch` every custom OpenAI-compatible request goes through. Defaults to the safeFetch
   * guard with private addresses refused; the server passes its self-host flag through
   * {@link createOpenAICompatibleFetch} when that setting is on.
   */
  readonly openAICompatibleFetch?: ProviderFetch
  /**
   * The `fetch` a Google Vertex request goes through, when a caller wants its own. Defaults to
   * the provider's (the global `fetch`): unlike Azure's, the endpoint is Google's own, derived
   * from the stored location rather than typed by a user, so there is nothing to guard.
   */
  readonly vertexFetch?: ProviderFetch
}

/**
 * The default {@link ModelFactory}: one official AI SDK provider per `provider/model` prefix.
 *
 * `provider/model` is what the protocol documents for a session's `model.id`, and the part
 * before the first slash chooses the client — `@ai-sdk/anthropic`, `@ai-sdk/openai`,
 * `@ai-sdk/google` and the rest of {@link PROVIDER_CLIENTS} — built with the request's key and
 * the pinned base URL. The key is a **constructor argument** and nothing else: the provider
 * packages read their `*_API_KEY` variable only when they were given no key, so a request with
 * an explicit one can never fall back to the environment (epic #65, A5). The key still has to
 * be non-blank for that reason — `isUsableCredential` checks it before `runTurn` gets this far,
 * so a blank key ends the turn instead of quietly becoming "no key given".
 *
 * Two providers use the **Responses API** rather than the chat one, because that is what the
 * router these replace resolved for them: OpenAI (`openai.responses(id)`) and xAI
 * (`xai.responses(id)`). Every other provider is a chat-completions client.
 *
 * A first half that is **not** one of the eleven provider ids names a *named credential*
 * instead (epic #245, A3a/A3b/A3c/A3d): an `azure` credential's model ids are
 * `azure/<deployment>`, a `custom` one's are `custom/<model>`, a `bedrock` one's are
 * `bedrock/<bedrock model id>` and a `vertex` one's are `vertex/<model>`, and the credential's
 * type decides the client. The credential's type is the discriminant, so a
 * name nothing stores a credential for is still an `UnsupportedProviderError` — the same ending
 * as before, and the turn writes no span for it.
 *
 * No `maxRetries`/`streamRetries` is configured here, because a provider client has neither:
 * both options live on the `streamText` call in {@link streamModelRequest}, which is the only
 * thing this package streams through (issue #117).
 *
 * @param modelId a model id, `provider/model` — or `<credential name>/<deployment>`
 * @param credential the credential this one request authenticates with
 * @throws UnsupportedProviderError when the id names a provider with no client here
 */
export function createProviderModelFactory(
  options: ProviderModelFactoryOptions = {},
): ModelFactory {
  const fixedFetch = options.fetch
  const azureGuard = options.azureFetch ?? azureFetch
  const customGuard = options.openAICompatibleFetch ?? openAICompatibleFetch
  const vertexFetch = options.vertexFetch
  return (modelId, credential) => {
    const provider = providerOf(modelId)
    // Everything after the first slash: the provider's own id for the model. A fireworks,
    // OpenRouter or Azure id carries slashes of its own, which is why this is not
    // `split('/')[1]`.
    const id = modelId.slice(provider.length + 1)
    const client = providerClientFor(provider)
    if (client !== undefined) {
      // A fixed provider id is authenticated with an `api_key` credential and nothing else: the
      // API refuses to store any other type under one, so a credential that is not one here is
      // a configuration the server cannot produce. It is answered like an unsupported provider
      // rather than by reaching for a key this credential does not have — a blank one would be
      // worse than an error, since the provider package would read its own environment.
      if (credential.type !== 'api_key') {
        throw new UnsupportedProviderError(provider)
      }
      // The `fetch` a host injected — the server passes its egress-proxy-aware client — is
      // handed to every fixed provider's client the way the key and the base URL are (#270).
      // Left out entirely when there is none, so the package uses the platform's `fetch`.
      return client.model({
        apiKey: credential.apiKey,
        baseURL: client.baseURL,
        ...(fixedFetch === undefined ? {} : { fetch: fixedFetch }),
      })(id)
    }
    if (credential.type === 'azure_openai') {
      // `chat`, not the provider's default: the default is the Responses API, which newer
      // deployments support and older ones (an `gpt-35-turbo` deployment someone still runs) do
      // not — and the deployment name is a string the user typed, so the factory cannot know.
      // The chat-completions API is the one every Azure deployment answers.
      return createAzure({
        apiKey: credential.apiKey,
        baseURL: azureBaseUrl(credential.endpoint),
        // The user's endpoint is a URL a user typed, so every request to it is guarded: private
        // addresses are refused on the model call exactly as they are on the save-time check.
        fetch: azureGuard,
      }).chat(id)
    }
    if (credential.type === 'openai_compatible') {
      // The official package for exactly this API, at the base URL the user chose. `name` is the
      // credential name, so a provider error names the credential the user sees in Settings.
      // `apiKey` is passed even when empty: the package sends no `Authorization` header for a
      // falsy key and has no environment fallback, which is what a keyless local endpoint wants.
      // `chatModel`, not the provider's default, for the same reason as Azure: the deployment is
      // a string the user typed, and chat completions is the API the family actually serves.
      return createOpenAICompatible({
        name: provider,
        baseURL: openAICompatibleBaseUrl(credential.baseUrl),
        apiKey: credential.apiKey,
        // A URL the user typed is guarded on every request: private addresses are refused unless
        // the server's self-host setting turned that off (`createOpenAICompatibleFetch`).
        fetch: customGuard,
      }).chatModel(id)
    }

    if (credential.type === 'bedrock') {
      // Every setting the provider needs is passed explicitly, so nothing is read from the
      // environment (epic #65, A5): the region, both keys and the session token would each fall
      // back to their `AWS_*` variable otherwise, and the base URL to
      // `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` — a request a deployment could redirect, and one the
      // decoy test in `bedrock-model.test.ts` pins.
      //
      // `apiKey: ''` is the one setting that looks like a no-op and is not. The provider treats
      // a non-blank `apiKey` (or `AWS_BEARER_TOKEN_BEDROCK`) as "authenticate with a bearer
      // token" and skips SigV4 entirely; an explicit empty string is a *string*, so the provider
      // sees a setting rather than an absent one and never consults that variable — an empty
      // bearer token is not a credential, so the client stays on the SigV4 path with the user's
      // stored keys. Without it, a deployment with `AWS_BEARER_TOKEN_BEDROCK` in its environment
      // would silently authenticate every Bedrock request with a token no user saved.
      return createAmazonBedrock({
        region: credential.region,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        // Both keys are explicit, so the provider uses this field alone — an absent token stays
        // absent and `AWS_SESSION_TOKEN` is never read.
        ...(credential.sessionToken === undefined ? {} : { sessionToken: credential.sessionToken }),
        apiKey: '',
        baseURL: bedrockRuntimeBaseUrl(credential.region),
      })(id)
    }

    if (credential.type === 'vertex') {
      return vertexModel(id, credential, vertexFetch)
    }
    throw new UnsupportedProviderError(provider)
  }
}

/**
 * The model client for one Vertex model id (epic #245, A3d).
 *
 * The project, the location and **the service-account key** are all constructor arguments, and
 * that is the whole of "no fallback, and no Application Default Credentials" — the reason this
 * type exists and the reason it is critical here: the server itself runs on GCP, so a request
 * that quietly fell back to the environment would run a user's chat on openharness's own
 * service account.
 *
 * Three of the provider's settings are passed for exactly that reason:
 *
 * - `googleAuthOptions.credentials` is the parsed key document. `google-auth-library` builds its
 *   JWT client from it and never looks for ADC — no `GOOGLE_APPLICATION_CREDENTIALS`, no
 *   well-known file, no gcloud config, no metadata server. `vertex-model.test.ts` holds that
 *   with every one of those decoys present.
 * - `project` and `location` are the stored ones. Left undefined, each falls back to its
 *   `GOOGLE_VERTEX_PROJECT` / `GOOGLE_VERTEX_LOCATION` variable, which would move a request —
 *   and the key it authenticates with — to a project nobody chose.
 * - `apiKey: ''`, deliberately empty rather than absent: a truthy `apiKey` (or one left
 *   undefined, which lets the provider read `GOOGLE_VERTEX_API_KEY`) switches the whole client
 *   into Vertex "express mode", where the requests are authenticated by that key instead. An
 *   empty string is a value the provider sees and rejects as falsy, so the service-account path
 *   is the only one left.
 *
 * The model's family decides the client (see `vertex.ts`); an id belonging to neither — a
 * free-text id a host typed, since the catalogue offers only the two families — goes to the
 * Gemini client, and Google answers with its own error rather than this build refusing on the
 * user's behalf.
 */
function vertexModel(
  id: string,
  credential: VertexModelCredential,
  fetch: ProviderFetch | undefined,
): LanguageModel {
  const settings = {
    project: credential.project,
    location: credential.location,
    apiKey: '',
    googleAuthOptions: { credentials: googleCredentials(credential.serviceAccount) },
    ...(fetch === undefined ? {} : { fetch }),
  }
  if (isVertexAnthropicModel(id)) {
    return createVertexAnthropic(settings).languageModel(id)
  }
  return createVertex(settings).languageModel(id)
}

/**
 * The service-account document as `google-auth-library` takes it, or an error that names the
 * problem and no part of the key.
 *
 * A credential that reached here already passed the protocol's check on save, so this is the
 * belt to that schema's braces: a row edited by hand, or one written before the check existed,
 * must fail with a sentence a reader can act on rather than a stack trace from the auth library.
 */
function googleCredentials(serviceAccount: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(serviceAccount)
  } catch {
    throw new Error('the stored Vertex service account is not JSON; save the credential again')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the stored Vertex service account is not a key document; save it again')
  }
  return parsed as Record<string, unknown>
}

/** The factory a host runs unless it has a reason to inject one. */
export const providerModelFactory: ModelFactory = createProviderModelFactory()

/**
 * The service account's **private key** — the PEM inside the stored document, which is what a
 * request signs its OAuth token with — or the empty string when the document carries none.
 *
 * This is the one piece of a Vertex credential that must never appear in text: the rest of the
 * document (the project, the client email, the key id) is metadata a reader may see, and it is
 * exactly what the credential's `details` publishes. `credentialSecrets` reads this, so a
 * provider that echoes a rejected request back cannot leak the key into the log.
 */
function vertexPrivateKey(serviceAccount: string): string {
  try {
    const parsed: unknown = JSON.parse(serviceAccount)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const key: unknown = (parsed as Record<string, unknown>).private_key
      if (typeof key === 'string') {
        return key
      }
    }
  } catch {
    // Not JSON at all: there is no private key to find, and so no secret to scrub.
  }
  return ''
}

/**
 * The provider of a `provider/model` id: the part before the first slash.
 *
 * This is the key {@link ResolveCredential} is asked for — the same provider id the
 * credential's own provider field carries. An id with no slash is its own provider, so a
 * stray config cannot silently resolve somebody else's credential.
 *
 * @param modelId the session's `model.id`
 */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash === -1 ? modelId : modelId.slice(0, slash)
}

/**
 * Whether a resolved credential can authenticate a request.
 *
 * `null` means the owner has no credential for the provider. A blank key counts as none as
 * well, and that is not a formality: every provider in {@link providerModelFactory} reads its
 * own `*_API_KEY` environment variable when the key it was constructed with is falsy, so a
 * blank key would silently become "no key given" and hand the request to whatever the process
 * happens to have set — the fallback epic #65 (A5) forbids. So everything that is not a
 * usable key ends the request the same way. A custom OpenAI-compatible credential is the one
 * exception: its endpoint may take no key, so for it the base URL is what is checked instead.
 *
 * @param credential what {@link ResolveCredential} answered
 */
export function isUsableCredential(
  credential: ModelCredential | null,
): credential is ModelCredential {
  if (credential === null) {
    return false
  }
  // A Vertex credential has no key field: what authenticates the request is the service-account
  // document, so "is it usable" is whether that document, and the two settings the endpoint is
  // built from, are there. It is checked here rather than at the factory for the same reason
  // the Azure endpoint is: the turn then ends with `missing_provider_credential` — the ending
  // that says "save one" — instead of a span that fails on a malformed document.
  if (credential.type === 'vertex') {
    return (
      credential.serviceAccount.trim().length > 0 &&
      credential.project.trim().length > 0 &&
      credential.location.trim().length > 0
    )
  }
  // A custom OpenAI-compatible endpoint may take no key at all, so for it the **base URL**, not
  // the key, is what has to be non-blank — a missing one could not build a request, which is a
  // "save a credential" ending (`missing_provider_credential`), not a malformed-URL span.
  if (credential.type === 'openai_compatible') {
    return credential.baseUrl.trim().length > 0
  }
  if (credential.type === 'azure_openai') {
    // An Azure credential with no endpoint could not build a request at all. It is refused here
    // rather than at the factory, so the turn ends with `missing_provider_credential` — the
    // ending that says "save one" — instead of a span that fails on a malformed URL.
    return credential.apiKey.trim().length > 0 && credential.endpoint.trim().length > 0
  }
  if (credential.type === 'bedrock') {
    // Neither half of a SigV4 signature may be blank, and neither may the region of the host it
    // signs for. A blank half is not merely useless: `@ai-sdk/amazon-bedrock` resolves each of
    // its three `AWS_*` variables only when the matching setting is absent, and an empty string
    // is the shape that could slip past that test — the same danger the blank api_key rule is
    // about. A session token is genuinely optional, so an absent one is fine.
    return (
      credential.accessKeyId.trim().length > 0 &&
      credential.secretAccessKey.trim().length > 0 &&
      credential.region.trim().length > 0
    )
  }
  // The key-shaped credentials are what is left, and a blank key counts as none: every provider
  // in {@link providerModelFactory} reads its own `*_API_KEY` variable when the key it was
  // constructed with is falsy, so a blank one would silently become "no key given" and hand the
  // request to whatever the process happens to have set — the fallback epic #65 (A5) forbids.
  return credential.apiKey.trim().length > 0
}

/**
 * What the log says when a request had no credential to make: a sentence for the user, naming
 * the provider so a client can point at the right Settings entry (epic #65, A5).
 *
 * The name is the shared list's (`@openharness/protocol`), so it is the same words a frontend
 * puts on a provider's tile; a first half that names a named credential's default — `azure` —
 * reads as that type's display name, and anything else — a session whose `model.id` names
 * something nobody configured — falls back to its capitalised id.
 *
 * @param provider the provider id, as {@link providerOf} read it
 */
export function missingCredentialMessage(provider: string): string {
  const name =
    SHARED_PROVIDERS.find((entry) => entry.id === provider)?.name ??
    CREDENTIAL_TYPES.find((entry) => entry.defaultName === provider)?.name ??
    capitalize(provider)
  return `No ${name} key is set. Add one in Settings → Model providers.`
}

/** A provider id as a name: `mistral` → `Mistral`. */
function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}

/** Token counts for a request that never produced any: the AI SDK reports nothing to map. */
export const ZERO_MODEL_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** How deep a `{ total }` chain is followed before a value is called unreadable. */
const MAX_USAGE_DEPTH = 3

/** A value as a string-keyed record, or `null` when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * A value as a count the protocol accepts — a non-negative integer — or `undefined` when it
 * carries no number at all. A numeric string counts: it is a count that arrived spelled out,
 * not one that was lost.
 */
function asCount(value: unknown): number | undefined {
  const spelled = typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined
  const count = typeof value === 'number' ? value : spelled
  return count !== undefined && Number.isFinite(count) ? Math.max(0, Math.round(count)) : undefined
}

/**
 * A usage report's count, wherever the report put it.
 *
 * Every provider in {@link providerModelFactory} declares the spec it implements, so a report
 * arrives as the numbers the protocol wants (`inputTokens: 10`). A report that does not — a
 * provider whose declaration and payload disagree, or one that reports the count one `total`
 * down (`{ total: 10, noCache: 10, … }`) — is still read: the count is looked for inside the
 * value as well as on it. Nothing else has to know which shape arrived.
 */
function countOf(value: unknown, depth = 0): number | undefined {
  const count = asCount(value)
  if (count !== undefined) {
    return count
  }
  const record = asRecord(value)
  if (record === null || depth >= MAX_USAGE_DEPTH) {
    return undefined
  }
  return countOf(record.total, depth + 1)
}

/**
 * The first readable `field` on a usage value, or on the usage values nested under its `total`s.
 *
 * This is how the cache counters survive the same mismatch: a report that puts its breakdown
 * inside the usage object rather than beside it (`{ inputTokens: { total, cacheRead, … } }`,
 * the shape `countOf` also has to read through) is only findable inside it.
 */
function detailOf(value: unknown, field: string, depth = 0): number | undefined {
  const record = asRecord(value)
  if (record === null || depth >= MAX_USAGE_DEPTH) {
    return undefined
  }
  return asCount(record[field]) ?? detailOf(record.total, field, depth + 1)
}

/** How one model request is made. */
export interface ModelRequestParams {
  /** The model to stream from, already resolved by the factory. */
  readonly model: LanguageModel
  /** The messages to send, system prompt included; see `ContextStrategy`. */
  readonly messages: readonly ModelMessage[]
  /**
   * Per-provider options for this one request — the provider's own knobs, keyed the way its AI
   * SDK client reads them. The loop's use of it is the reasoning effort (`./reasoning`), which
   * is the one thing openharness sends that the AI SDK's own call options do not express.
   */
  readonly providerOptions?: ProviderOptions
  /** Aborting this ends the request early; the partial text is still in the result. */
  readonly signal?: AbortSignal
  /**
   * Called with each text chunk as it arrives, and awaited: the loop stores the chunk before
   * the next one is pulled, so a store refusal surfaces here rather than being swallowed.
   */
  readonly onTextDelta?: (text: string) => Promise<void> | void
}

/**
 * What a model request produced, however it ended.
 *
 * It answers rather than throws — including for a failure — because all three endings lead
 * back into the turn loop as events, and a `catch` at each call site would only be a second
 * place that has to know about aborting.
 */
export interface ModelRequestResult {
  /** The text streamed so far. Kept on abort; dropped by the caller on failure. */
  readonly text: string
  /** Token counts, or {@link ZERO_MODEL_USAGE} when the request never reported any. */
  readonly usage: ModelUsage
  /** Why the request failed, or `undefined` when it succeeded. */
  readonly error: unknown
  /** Whether the request was cut short by `signal`. */
  readonly aborted: boolean
}

/**
 * Stream one model request.
 *
 * Text arrives as AI SDK stream parts; a provider failure arrives as an `error` part (the SDK
 * reports it through `onError` and keeps the stream alive, so it is captured there and reported
 * once, after the stream ends). An abort ends the stream with an `abort` part, and the partial
 * text is kept — the turn loop stores it.
 */
export async function streamModelRequest(params: ModelRequestParams): Promise<ModelRequestResult> {
  const failures: unknown[] = []
  const stepUsages: ModelUsage[] = []
  let aborted = false
  let text = ''
  const result = streamText({
    model: params.model,
    messages: [...params.messages],
    abortSignal: params.signal,
    // The provider's own options for this request, when the loop has any to send (the reasoning
    // effort): `undefined` here is the AI SDK's own "nothing to add", so a request with no
    // effort reaches the provider exactly as it did before #252.
    providerOptions: params.providerOptions,
    // The context strategy puts the session's system prompt in `messages`, which is where the
    // loop hands it over; the AI SDK otherwise warns about a system message there.
    allowSystemInMessages: true,
    // The turn loop owns retries — it writes the `session.error` and `session.status_*` events
    // an SDK-level retry would silently skip — so the SDK must not retry underneath it. In
    // `ai@7` two options control retries, and only the second is about streaming:
    // - `maxRetries` bounds the provider retries of one model call and defaults to 2, so it
    //   must be 0: left at the default, one failure makes up to three provider calls the loop
    //   never sees, and what the loop does see is an `AI_RetryError` wrapper around the
    //   provider's error rather than the error itself.
    // - `streamRetries` bounds only provider errors received *after* streaming has started;
    //   its default is already 0 (disabled when omitted). It is kept explicit so a changed
    //   default cannot re-enable those retries. `onError` here never returns `{ retry: true }`,
    //   the one way a stream error could still be retried with this set.
    maxRetries: 0,
    streamRetries: 0,
    onError: ({ error }) => {
      failures.push(error)
    },
  })
  try {
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += part.text
        await params.onTextDelta?.(part.text)
      } else if (part.type === 'abort') {
        aborted = true
      } else if (part.type === 'finish-step') {
        // The model's own report for one step, read as it arrives: the SDK's `result.usage`
        // below is an *accumulation* over these, so a step is the most truthful place to read
        // the counts from — each one is what the provider reported, not a sum this process
        // built.
        stepUsages.push(toModelUsage(part.usage))
      }
    }
  } catch (error) {
    // A write the store refused is not a model failure and must not be retried as one: it means
    // another owner has taken the partition over — or claimed the events this request answers —
    // and the loop has to stop right here. Deltas are appended from `onTextDelta`, so a refusal
    // inside the stream surfaces here.
    if (isOwnershipError(error)) {
      throw error
    }
    failures.push(error)
  }

  if (aborted || params.signal?.aborted === true) {
    return { text, usage: ZERO_MODEL_USAGE, error: undefined, aborted: true }
  }
  const failure = failures[0]
  if (failure !== undefined) {
    if (isOwnershipError(failure)) {
      throw failure
    }
    return { text, usage: ZERO_MODEL_USAGE, error: failure, aborted: false }
  }
  const usage =
    stepUsages.length === 0
      ? // No step reported anything (a model that streams text without usage), so the SDK's
        // total is the only report there is.
        toModelUsage(await result.usage)
      : stepUsages.reduce(addModelUsage)
  return { text, usage, error: undefined, aborted: false }
}

/**
 * The protocol's token counts for an AI SDK usage report.
 *
 * The protocol keeps Anthropic's four counters, and they are **disjoint**: `input_tokens` is the
 * uncached input and the two cache counters the cached halves, which is what lets `usageCost`
 * price each at its own rate without double-charging a token. The AI SDK reports something else:
 * `inputTokens` is the **cache-inclusive total**, and `inputTokenDetails` carries the breakdown.
 * On Anthropic the two disagree about what "input tokens" means — the provider's own
 * `input_tokens` leaves cached tokens out, so its total is the three input-side counters summed —
 * while on OpenAI and the OpenAI-compatible family `prompt_tokens` already includes the cached
 * ones and the total is the raw number. `toModelUsage` is the one place that normalises the
 * provider families apart, and it does it by reading the SDK's `noCacheTokens`, which each
 * provider package computes correctly for its own API: the uncached half, for every family.
 * Summing the three input-side counters of the result is therefore the real prompt size a request
 * was made with (epic #277, K2), for every provider.
 *
 * Takes `unknown` because the report that actually arrives is not always the shape its type
 * promises — an `ai` version and a provider package that disagree about the provider spec
 * would reshape it on the way through, and the counters the protocol needs would be inside an
 * object where a number belongs. The providers this package builds declare the spec they
 * implement, so that cannot happen today; reading the count wherever it survived costs
 * nothing and is what keeps a bad pairing from shipping the unreadable totals of issue #39
 * instead of an error. The protocol's schema is right to demand integers, so a value that
 * carries no count is `0`, never a value the log would reject. The counters are the ones the
 * request really spent, which is why the caller hands over the model's own step report rather
 * than the SDK's accumulated total.
 *
 * @param usage what the request reported, in whatever shape it arrived
 */
export function toModelUsage(usage: unknown): ModelUsage {
  const report = asRecord(usage) ?? {}
  const details = asRecord(report.inputTokenDetails) ?? {}
  const input = report.inputTokens
  const cache_read_input_tokens =
    detailOf(details, 'cacheReadTokens') ?? detailOf(input, 'cacheRead') ?? 0
  const cache_creation_input_tokens =
    detailOf(details, 'cacheWriteTokens') ?? detailOf(input, 'cacheWrite') ?? 0
  // The uncached input, the half the protocol stores. A report that carries no breakdown
  // (a numeric `inputTokens`, or one nested where a number belongs) is normalized here: the
  // total minus both cache halves, never below zero.
  const noCache = detailOf(details, 'noCacheTokens')
  const total = countOf(input) ?? 0
  return {
    input_tokens:
      noCache ?? Math.max(0, total - cache_read_input_tokens - cache_creation_input_tokens),
    output_tokens: countOf(report.outputTokens) ?? 0,
    cache_read_input_tokens,
    cache_creation_input_tokens,
  }
}

/** One request's counters, step by step: every step of a request is spent inside the same span. */
function addModelUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens,
    cache_creation_input_tokens:
      left.cache_creation_input_tokens + right.cache_creation_input_tokens,
  }
}
