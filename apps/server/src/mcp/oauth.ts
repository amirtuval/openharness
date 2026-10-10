import { createHash, randomBytes } from 'node:crypto'

import type { McpFetch } from '@openharness/hands'

/**
 * The OAuth 2.1 client a remote MCP server is authenticated with (epic #303, X10).
 *
 * This server is the OAuth **client**, for the web app and `oh` alike: it discovers the
 * authorization server, registers itself dynamically when the server supports it, runs the
 * authorization-code flow with PKCE, and refreshes tokens. It is written here rather than
 * delegated to the MCP SDK's own `OAuthClientProvider` because the tokens have to be sealed in
 * this deployment's vault and refreshed by this server's own code — and because the flow's
 * `state` is bound to a user and a server this deployment knows, which a generic provider has
 * no seam for.
 *
 * The standards, and where each is used:
 *
 * - **RFC 9728** — the protected-resource metadata (`/.well-known/oauth-protected-resource…`)
 *   names the authorization server(s) for the MCP server's URL.
 * - **RFC 8414** — the authorization-server metadata (`/.well-known/oauth-authorization-server…`,
 *   with the OIDC discovery document as a fallback) names the authorize, token and registration
 *   endpoints.
 * - **RFC 7591** — dynamic client registration, used when the metadata carries a
 *   `registration_endpoint`. A server that does not is a clear error; pre-registered client ids
 *   are a follow-up.
 * - **PKCE** (RFC 7636, `S256`) — always, as the spec requires of a public client.
 *
 * Every request goes through the injected {@link McpFetch}, which the deployment builds over
 * `safeFetch` — so the authorization server's own host is subject to the same SSRF guard as the
 * MCP server's, and a discovery document pointing at a private address is refused rather than
 * dialled.
 */

/** A refusal or failure of the OAuth flow. The message is safe to show a user; it carries no secret. */
export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpOAuthError'
  }
}

/** RFC 9728 protected-resource metadata, as the subset this client reads it. */
export interface ProtectedResourceMetadata {
  /** The resource the metadata describes; not required to match the URL asked about. */
  readonly resource?: string
  /** The authorization server issuer identifiers; the first is used. */
  readonly authorization_servers: readonly string[]
  /** The scopes the resource says it needs, when it names any. */
  readonly scopes_supported?: readonly string[]
}

/** RFC 8414 authorization-server metadata, as the subset this client reads it. */
export interface AuthorizationServerMetadata {
  readonly issuer?: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  /** RFC 7591 registration endpoint, when the server supports dynamic registration. */
  readonly registration_endpoint?: string
  readonly scopes_supported?: readonly string[]
  readonly code_challenge_methods_supported?: readonly string[]
}

/** The client registration this server stored, plus the endpoints it was discovered from. */
export interface OAuthClientRegistration {
  readonly client_id: string
  readonly client_secret?: string
  /** The authorization endpoint the flow starts at, carried so the callback needs no discovery. */
  readonly authorization_endpoint: string
  /** The token endpoint the code and refresh grants go to. */
  readonly token_endpoint: string
  /** The issuer the endpoints were discovered from, for diagnostics. */
  readonly issuer?: string
  /** The scopes the resource asked for, if it asked. */
  readonly scopes?: readonly string[]
}

/** The tokens a token response carried, as this server stores them (sealed). */
export interface OAuthTokens {
  readonly access_token: string
  readonly token_type: string
  readonly refresh_token?: string
  /** When the access token expires, as an RFC 3339 instant; absent when the server sent no `expires_in`. */
  readonly expires_at?: string
  readonly scope?: string
}

/** One authorization code + PKCE pair. */
export interface PkcePair {
  /** The code verifier, sent with the token request. */
  readonly verifier: string
  /** The `S256` challenge, sent with the authorization request. */
  readonly challenge: string
}

/** How a request is made; the deployment injects a `safeFetch`-backed wrapper. */
export type OAuthFetch = McpFetch

/**
 * The URL of a resource's protected-resource metadata (RFC 9728).
 *
 * The well-known segment goes between the host and the resource's path: the metadata for
 * `https://mcp.example.com/mcp` is at `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`.
 * A resource with no path answers at the origin's own well-known document.
 */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const resource = new URL(resourceUrl)
  const path = resource.pathname === '/' ? '' : resource.pathname.replace(/\/$/, '')
  return new URL(`/.well-known/oauth-protected-resource${path}`, resource).href
}

/**
 * The candidate URLs of an authorization server's metadata, in the order they are tried.
 *
 * RFC 8414's own document first — the well-known segment inserted before the issuer's path, as
 * RFC 9728 does — then the OIDC discovery document, which many providers publish instead.
 */
export function authorizationServerMetadataUrls(issuer: string): readonly string[] {
  const base = new URL(issuer)
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, base).href,
    new URL(`/.well-known/openid-configuration${path}`, base).href,
  ]
}

/** Discover a resource's authorization server (RFC 9728). */
export async function discoverResource(
  fetch: OAuthFetch,
  resourceUrl: string,
): Promise<ProtectedResourceMetadata> {
  const document = await readJson(fetch, protectedResourceMetadataUrl(resourceUrl))
  const servers = document['authorization_servers']
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new McpOAuthError(
      `${resourceUrl} does not advertise an authorization server ` +
        '(its protected-resource metadata carries no `authorization_servers`)',
    )
  }
  const authorizationServers = servers.filter(
    (server): server is string => typeof server === 'string' && server.length > 0,
  )
  return {
    ...(typeof document['resource'] === 'string' ? { resource: document['resource'] } : {}),
    authorization_servers: authorizationServers,
    ...scopesFrom(document),
  }
}

/** Discover an authorization server's metadata (RFC 8414, OIDC as a fallback). */
export async function discoverAuthorizationServer(
  fetch: OAuthFetch,
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  let lastError: unknown
  for (const url of authorizationServerMetadataUrls(issuer)) {
    try {
      return parseAuthorizationServerMetadata(await readJson(fetch, url), url)
    } catch (error) {
      lastError = error
    }
  }
  throw new McpOAuthError(
    `could not read the authorization server metadata for ${issuer}: ` +
      `${lastError instanceof Error ? lastError.message : 'the document could not be read'}`,
  )
}

/** Read and validate an authorization-server metadata document. */
function parseAuthorizationServerMetadata(
  document: Record<string, unknown>,
  url: string,
): AuthorizationServerMetadata {
  const authorizationEndpoint = document['authorization_endpoint']
  const tokenEndpoint = document['token_endpoint']
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    throw new McpOAuthError(`${url} does not carry both an authorization and a token endpoint`)
  }
  return {
    ...(typeof document['issuer'] === 'string' ? { issuer: document['issuer'] } : {}),
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    ...(typeof document['registration_endpoint'] === 'string'
      ? { registration_endpoint: document['registration_endpoint'] }
      : {}),
    ...scopesFrom(document),
    ...(Array.isArray(document['code_challenge_methods_supported'])
      ? {
          code_challenge_methods_supported: document['code_challenge_methods_supported'].filter(
            (method): method is string => typeof method === 'string',
          ),
        }
      : {}),
  }
}

/** Register this server as a public OAuth client (RFC 7591). */
export async function registerClient(
  fetch: OAuthFetch,
  metadata: AuthorizationServerMetadata,
  options: { readonly redirectUri: string; readonly clientName: string },
): Promise<{ client_id: string; client_secret?: string }> {
  if (metadata.registration_endpoint === undefined) {
    throw new McpOAuthError(
      'the authorization server does not support dynamic client registration ' +
        '(its metadata carries no `registration_endpoint`); a pre-registered client is not ' +
        'supported yet',
    )
  }
  const response = await sendJson(fetch, metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: options.clientName,
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  const clientId = response['client_id']
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new McpOAuthError('the registration response carried no `client_id`')
  }
  return {
    client_id: clientId,
    ...(typeof response['client_secret'] === 'string' && response['client_secret'].length > 0
      ? { client_secret: response['client_secret'] }
      : {}),
  }
}

/** A fresh PKCE verifier and its `S256` challenge. */
export function createPkce(): PkcePair {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Build the authorization URL the user's browser is sent to. */
export function authorizationUrl(
  metadata: Pick<AuthorizationServerMetadata, 'authorization_endpoint'>,
  request: {
    readonly clientId: string
    readonly redirectUri: string
    readonly state: string
    readonly challenge: string
    readonly resource: string
    readonly scopes?: readonly string[]
  },
): string {
  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', request.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('state', request.state)
  url.searchParams.set('code_challenge', request.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707: tell the authorization server which protected resource the token is for, so an
  // authorization server serving several APIs mints a token for this one.
  url.searchParams.set('resource', request.resource)
  if (request.scopes !== undefined && request.scopes.length > 0) {
    url.searchParams.set('scope', request.scopes.join(' '))
  }
  return url.href
}

/** Exchange an authorization code for tokens (PKCE). */
export async function exchangeAuthorizationCode(
  fetch: OAuthFetch,
  metadata: Pick<AuthorizationServerMetadata, 'token_endpoint'>,
  request: {
    readonly code: string
    readonly codeVerifier: string
    readonly redirectUri: string
    readonly clientId: string
    readonly clientSecret?: string
    readonly resource: string
    /** The clock `expires_in` is turned into an instant with; `Date.now` by default. */
    readonly now?: () => Date
  },
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectUri,
    client_id: request.clientId,
    resource: request.resource,
  })
  return readTokenResponse(
    await sendJson(fetch, metadata.token_endpoint, {
      method: 'POST',
      headers: formHeaders(request.clientSecret, request.clientId),
      body: body.toString(),
    }),
    request.now,
  )
}

/** Refresh an access token. */
export async function refreshAccessToken(
  fetch: OAuthFetch,
  metadata: Pick<AuthorizationServerMetadata, 'token_endpoint'>,
  request: {
    readonly refreshToken: string
    readonly clientId: string
    readonly clientSecret?: string
    /** The clock `expires_in` is turned into an instant with; `Date.now` by default. */
    readonly now?: () => Date
  },
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
    client_id: request.clientId,
  })
  return readTokenResponse(
    await sendJson(fetch, metadata.token_endpoint, {
      method: 'POST',
      headers: formHeaders(request.clientSecret, request.clientId),
      body: body.toString(),
    }),
    request.now,
  )
}

/**
 * The token response, parsed and checked.
 *
 * `expires_in` becomes an instant against the caller's clock, not the wall clock: the server
 * carries one clock through a request, and a test that moves it must move a token's expiry with
 * it.
 */
function readTokenResponse(
  document: Record<string, unknown>,
  now: () => Date = () => new Date(),
): OAuthTokens {
  const accessToken = document['access_token']
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new McpOAuthError('the token response carried no `access_token`')
  }
  const expiresIn = document['expires_in']
  return {
    access_token: accessToken,
    token_type: typeof document['token_type'] === 'string' ? document['token_type'] : 'Bearer',
    ...(typeof document['refresh_token'] === 'string' && document['refresh_token'].length > 0
      ? { refresh_token: document['refresh_token'] }
      : {}),
    ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? { expires_at: new Date(now().getTime() + expiresIn * 1000).toISOString() }
      : {}),
    ...(typeof document['scope'] === 'string' ? { scope: document['scope'] } : {}),
  }
}

/** The headers a form token request carries, with Basic auth when the client has a secret. */
function formHeaders(clientSecret: string | undefined, clientId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (clientSecret !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  }
  return headers
}

/** Fetch a JSON document, refusing a non-2xx answer with a bounded, secret-free message. */
async function readJson(fetch: OAuthFetch, url: string): Promise<Record<string, unknown>> {
  return parseJsonDocument(await send(fetch, url))
}

/** Fetch and parse a JSON object, refusing anything that is not one. */
async function sendJson(
  fetch: OAuthFetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  return parseJsonDocument(await send(fetch, url, init))
}

/** One request, refusing a non-2xx status. The body is not read here — the caller parses it. */
async function send(fetch: OAuthFetch, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { redirect: 'manual', ...init })
  } catch (error) {
    throw new McpOAuthError(
      `could not reach ${url}: ${error instanceof Error ? error.message : 'the request failed'}`,
    )
  }
  if (!response.ok) {
    // The body of a failing OAuth response can quote the request; a bounded read keeps it out
    // of the message beyond a short reason, and the record's own `error`/`error_description`
    // is the useful part when it is JSON.
    const detail = await errorDetail(response)
    throw new McpOAuthError(`${url} answered ${response.status}${detail}`)
  }
  return response
}

/** A bounded reason from a failing response, if it is JSON, and nothing if not. */
async function errorDetail(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return ''
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const error = record['error']
      const description = record['error_description']
      if (typeof error === 'string') {
        return `: ${error}${typeof description === 'string' ? ` — ${description}` : ''}`.slice(
          0,
          300,
        )
      }
    }
  } catch {
    // Not JSON; the status alone is what there is to say.
  }
  return ''
}

/** Parse a response body as a JSON object, refusing anything else. */
async function parseJsonDocument(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new McpOAuthError(`the response from ${response.url} was not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpOAuthError(`the response from ${response.url} was not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** The `scopes_supported` of a metadata document, when it carries a usable one. */
function scopesFrom(document: Record<string, unknown>): { scopes_supported?: readonly string[] } {
  const scopes = document['scopes_supported']
  if (!Array.isArray(scopes)) {
    return {}
  }
  const strings = scopes.filter((scope): scope is string => typeof scope === 'string')
  return strings.length === 0 ? {} : { scopes_supported: strings }
}

/** base64url of a buffer, without padding — the encoding PKCE uses. */
function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
