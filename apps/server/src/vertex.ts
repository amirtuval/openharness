/**
 * The Google-side facts a Vertex credential needs (epic #245, A3d; #273): an OAuth token for
 * its service account, the URL that proves the account can reach the project and location it
 * was saved with, and — since #273 — the Model Garden calls the **catalogue** lists a project's
 * models with.
 *
 * They live here rather than inside `provider-validation.ts` or `catalog/` because they are
 * Google's rules and not a policy of this server's: the save-time check is one request built
 * out of them, the catalogue's listing is two more, and both callers would otherwise restate
 * the same hosts and paths.
 *
 * **The token is signed with the stored key and nothing else.** `GoogleAuth` is constructed
 * with the parsed document as its `credentials`, which is the one path through
 * `google-auth-library` that never consults Application Default Credentials: no
 * `GOOGLE_APPLICATION_CREDENTIALS`, no well-known file, no gcloud config, no metadata server.
 * This is the same guarantee the brain's model path makes, made in the place the *save* is
 * checked — and it matters for the same reason, since this server runs on GCP.
 */

import { GoogleAuth } from 'google-auth-library'

/** The scope a Vertex request authenticates with. */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * How a service-account document becomes a bearer token; injectable, so no test reaches
 * Google's token endpoint.
 */
export type VertexTokenProvider = (serviceAccount: string) => Promise<string>

/**
 * The production token provider: sign a JWT with the stored key, exchange it for an access
 * token.
 *
 * A rejected key surfaces Google's own reason — `invalid_grant: Invalid JWT Signature`,
 * `invalid_grant: Invalid grant: account not found`, an expired or revoked key — which the
 * caller turns into the 422 a failed save gets. Nothing of the document is echoed: the
 * library's message names the failure, never the key.
 *
 * The client is built per call, deliberately: a token belongs to the credential that asked for
 * it, and caching one across saves would mean a credential's second validation could be
 * answered by the first credential's token.
 */
export function createVertexTokenProvider(): VertexTokenProvider {
  return async (serviceAccount) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(serviceAccount)
    } catch (error) {
      throw new Error('the stored service account is not JSON; save the credential again', {
        cause: error,
      })
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        'the stored service account is not a key document Google Cloud issued; save the ' +
          'credential again',
      )
    }
    const auth = new GoogleAuth({
      scopes: [CLOUD_PLATFORM_SCOPE],
      credentials: parsed as Record<string, unknown>,
    })
    const token = await auth.getClient().then((client) => client.getAccessToken())
    if (token.token === null || token.token === undefined || token.token === '') {
      // A token client that answers nothing is a failure, not a credential that "worked".
      throw new Error('Google did not issue an access token for this service account')
    }
    return token.token
  }
}

/** The provider the server runs unless a host injects one. */
export const vertexTokenProvider: VertexTokenProvider = createVertexTokenProvider()

/**
 * Where a location's **endpoints** are listed — the save-time check's read.
 *
 * `projects.locations.endpoints.list` — `GET https://{host}/v1/projects/{project}/locations/
 * {location}/endpoints?pageSize=1` — is the cheapest authenticated Vertex read that is *about
 * this credential's own project and location*. (An earlier version of this check read
 * `…/publishers/google/models`; that path does not exist — the publishers surface is global
 * and spells its listing `v1beta1/publishers/{publisher}/models` — so Google answered every
 * save with a **404 text/html**, and the check could never pass. See `vertexModelGardenListUrl`
 * for the listing the catalogue uses.) Two things make this the right route:
 *
 * - **It proves all three facts it has to.** A key Google rejects is a **401
 *   `application/json`** `UNAUTHENTICATED` with Google's own message; a project or location
 *   the account cannot see, and a project without the Vertex AI API enabled, are 403/404 in
 *   Google's words naming it — the misconfiguration a perfectly good key usually meets.
 * - **It asks only for permissions `roles/aiplatform.user` carries.** Reading endpoints
 *   needs `aiplatform.endpoints.list`, which that role includes (it is the read a user who
 *   may call models already has) — a check no more privileged than the model calls the
 *   credential is saved to make.
 *
 * One endpoint is enough: the answer's *existence* is the proof, and asking for a page keeps
 * the response to a few hundred bytes. Nothing in the response is read.
 *
 * The host is Google's, derived from the location exactly as the AI SDK derives it: the
 * `global` location is served from the apex host, and every other location from
 * `<location>-aiplatform.googleapis.com`. A user never types a host — the protocol validates
 * the location against Google's published list, and this is what turns it into an endpoint.
 */
export function vertexEndpointsUrl(input: {
  readonly project: string
  readonly location: string
}): string {
  const path = `v1/projects/${encodeURIComponent(input.project)}/locations/${encodeURIComponent(
    input.location,
  )}/endpoints`
  return `https://${vertexHost(input.location)}/${path}?pageSize=1`
}

/** The host a location's Vertex requests go to: `global` is the apex, a region is prefixed. */
function vertexHost(location: string): string {
  return location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`
}

// ------------------------------------------------------- Model Garden (#273)

/**
 * The publishers whose models a Vertex project can call, and the ones this build has clients
 * for: Google's own models and Anthropic's, served from the same credential.
 *
 * The Model Garden catalogue is organized by **publisher**, which is what the listing endpoint
 * is scoped by — `publishers/google/models` and `publishers/anthropic/models`. A third-party
 * model Google resells (a MaaS model) lives under its own publisher and is deliberately left
 * out: this build has no client for one (#251's `isVertexModelId`).
 */
export const VERTEX_PUBLISHERS = ['google', 'anthropic'] as const

/** One of the publishers {@link VERTEX_PUBLISHERS} names. */
export type VertexPublisher = (typeof VERTEX_PUBLISHERS)[number]

/** How many models one page of a Model Garden list asks for. */
const PUBLISHER_MODEL_PAGE_SIZE = 1000

/**
 * One page of a publisher's Model Garden catalogue, for a location.
 *
 * This is `ModelGardenService.ListPublisherModels` — `GET
 * https://{host}/v1beta1/publishers/{publisher}/models` — the one endpoint that lists a
 * publisher's models, and the one the catalogue reads to see what the project can call. It is
 * **not** project- or location-scoped in its path (the parent is `publishers/{publisher}`
 * alone); the location only picks the host, exactly as it does for every other Vertex request,
 * and the project's own entitlements are a separate read per model (see
 * {@link vertexModelGardenEulaCheckUrl}).
 *
 * `v1beta1` is not a preference: the `v1` surface has no `list` method at all, and a
 * `v1` list path answers Google's own 404.
 */
export function vertexModelGardenListUrl(input: {
  readonly location: string
  readonly publisher: VertexPublisher
  readonly pageToken?: string
}): string {
  const path = `v1beta1/publishers/${input.publisher}/models`
  const pageToken = input.pageToken
  const query =
    pageToken === undefined
      ? `pageSize=${PUBLISHER_MODEL_PAGE_SIZE}`
      : `pageSize=${PUBLISHER_MODEL_PAGE_SIZE}&pageToken=${encodeURIComponent(pageToken)}`
  return `https://${vertexHost(input.location)}/${path}?${query}`
}

/**
 * Where one publisher model's **EULA acceptance** is checked for a project.
 *
 * `ModelGardenService.CheckPublisherModelEulaAcceptance` — `POST
 * https://aiplatform.googleapis.com/v1beta1/projects/{project}/modelGardenEula:check` — is the
 * project-scoped answer to "may this project call this partner model", and the API's own name
 * for the Model Garden "Enable" a reader clicks on a model card. A partner model (Anthropic's)
 * must be enabled per project, and the listing endpoint above cannot say whether it was; this
 * is the read that can, one model at a time.
 *
 * The host is the **global** one, always: the parent is `projects/{project}`, with no location
 * in the path, which is why nothing about this call depends on where the credential was saved.
 */
export function vertexModelGardenEulaCheckUrl(input: { readonly project: string }): string {
  return `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(
    input.project,
  )}/modelGardenEula:check`
}

/** The `publishers/{publisher}/models/{model}` resource name Google keys a publisher model by. */
export function vertexPublisherModelResource(input: {
  readonly publisher: VertexPublisher
  readonly model: string
}): string {
  return `publishers/${input.publisher}/models/${input.model}`
}

/** One publisher model a Model Garden list named, as far as the catalogue reads it. */
export interface PublisherModel {
  /** The raw model id, without the `publishers/{publisher}/models/` prefix. */
  readonly id: string
  /** The resource name Google spelled, e.g. `publishers/anthropic/models/claude-sonnet-4-5`. */
  readonly resource: string
}

/** One page of a publisher's model list. */
export interface PublisherModelPage {
  /** The models this page carried, in Google's order. */
  readonly models: readonly PublisherModel[]
  /** The cursor for the next page, or `null` when this was the last one. */
  readonly next: string | null
}

/**
 * One page of `ListPublisherModels`, as the catalogue's input.
 *
 * The payload is `{ publisherModels: [{ name, versionId, openSourceCategory, … }],
 * nextPageToken }` — see the REST reference and the `PublisherModel` message in
 * `@google-cloud/aiplatform`'s protos. Only two things are read here, and deliberately: the
 * resource `name` (which is the model id, and the only field a request is addressed with) and
 * the page token. There is **no field on a `PublisherModel` that says whether the calling
 * project may use it** — that is what the EULA check is for — and none that says whether the
 * model is a chat model, which is the catalogue's own filter to apply.
 *
 * An entry whose `name` is not a usable string is skipped rather than failing the page: a
 * resource with no id is not a model a caller could pick, and one such entry must not cost the
 * whole listing.
 *
 * @throws Error when the body is not a Model Garden list at all; the catalogue turns that into
 *   the credential's registry fallback, so an unexpected shape is a visible `fallback`.
 */
export function parsePublisherModelPage(body: unknown): PublisherModelPage {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('the publisher model list was not a JSON object')
  }
  const page = body as Record<string, unknown>
  const entries = page.publisherModels
  if (!Array.isArray(entries)) {
    throw new Error('the publisher model list carried no `publisherModels` array')
  }
  const models: PublisherModel[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue
    }
    const name = (entry as Record<string, unknown>).name
    if (typeof name !== 'string') {
      continue
    }
    const parsed = publisherModelOfResource(name)
    if (parsed !== null) {
      models.push(parsed)
    }
  }
  const next = page.nextPageToken
  return { models, next: typeof next === 'string' && next.length > 0 ? next : null }
}

/** One `publishers/{publisher}/models/{model}` resource name as a model, or `null`. */
function publisherModelOfResource(resource: string): PublisherModel | null {
  const parsed = /^publishers\/([^/]+)\/models\/(.+)$/u.exec(resource)
  if (parsed === null) {
    return null
  }
  const [, publisher, model] = parsed
  if (publisher === undefined || model === undefined || model.length === 0) {
    return null
  }
  return { id: model, resource }
}

/**
 * Whether `CheckPublisherModelEulaAcceptance` says the project has accepted a model's terms.
 *
 * The payload is `{ projectNumber, publisherModel, publisherModelEulaAcked }`; only the
 * boolean is read, and only an explicit `true` counts — an absent field means the API did not
 * say the terms were accepted, which is the state the catalogue must treat as "not enabled".
 *
 * @throws Error when the body is not a JSON object, so an unreadable answer is the credential's
 *   visible fallback rather than a silently empty (or silently full) model list.
 */
export function parsePublisherModelEulaAcceptance(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('the Model Garden EULA answer was not a JSON object')
  }
  return (body as Record<string, unknown>).publisherModelEulaAcked === true
}

/**
 * The one secret a Vertex credential carries — the key document's `private_key` — or `null`
 * when the stored text is not a document that has one.
 *
 * It is what a message about a failed Vertex call is scrubbed of (C3's rule for every
 * credential): a document that never parses has no string this could name, and a caller with
 * nothing to redact is left with `redactSecret`'s own no-op for `undefined`.
 */
export function vertexCredentialSecret(serviceAccount: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(serviceAccount)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const privateKey = (parsed as Record<string, unknown>).private_key
  return typeof privateKey === 'string' && privateKey.length > 0 ? privateKey : null
}
