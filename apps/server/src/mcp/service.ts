import { randomBytes } from 'node:crypto'

import {
  estimateToolsTokens,
  mcpToolSummary,
  MCP_LAST_ERROR_MAX_LENGTH,
  newMcpServerId,
  type CreateMcpServerRequest,
  type McpOAuthClient,
  type McpServer,
  type McpServerId,
  type McpToolDefinition,
  type McpToolSummary,
  type UpdateMcpServerRequest,
  type UserId,
} from '@openharness/protocol'
import {
  isSafeFetchError,
  openMcpClient,
  type McpFetch,
  type SafeFetchError,
} from '@openharness/hands'
import type { McpServerStore, StoredMcpServer, UpdateMcpServerInput } from '@openharness/session'
import type { Vault } from '@openharness/vault'

import { invalidRequest } from '../http/errors'
import type { Logger } from '../types'
import {
  authorizationUrl,
  createPkce,
  discoverAuthorizationServer,
  discoverResource,
  exchangeAuthorizationCode,
  McpOAuthError,
  refreshAccessToken,
  registerClient,
  type OAuthClientRegistration,
  type OAuthFetch,
  type OAuthTokens,
} from './oauth'
import { openMcpJson, sealMcpJson, type McpSecretBinding } from './secrets'

/**
 * The server-side half of the remote-MCP-server resource (epic #303, X10).
 *
 * It orchestrates the store, the vault and the MCP client: it seals the secrets a user saves,
 * runs the connection check, drives the OAuth 2.1 flow as the client, and — the seam issue
 * #312 uses — resolves a server to the URL and ready-to-use auth headers a tool call needs,
 * refreshing an OAuth token when it is about to expire and marking the server
 * `needs_reconnect` when a refresh fails.
 *
 * Every outbound request goes through the injected {@link McpFetch}, which the deployment
 * builds over `safeFetch`: the MCP server's URL and every endpoint the OAuth flow discovers
 * are subject to the same SSRF guard, and a private address is refused unless the self-host
 * setting allows it. Nothing here puts a secret in a response, in a log line, or in an error
 * message — a failing MCP server that quotes the request is scrubbed of the header values and
 * access tokens this server sent before its reason is reported.
 */

/** Why a connection check ended, and what it found. */
type CheckOutcome =
  | { readonly ok: true; readonly tools: readonly McpToolDefinition[] }
  | {
      readonly ok: false
      /** A URL the guard refused; the caller answers 400 rather than storing an error. */
      readonly refused: boolean
      /** A bounded, secret-free reason. */
      readonly error: string
      /** The underlying error, so a 401 can be told from any other failure. */
      readonly raw: unknown
    }

/**
 * A server the tool loop can use: its URL and the headers a request carries (epic #303, X10).
 *
 * This is the interface #312 consumes. `headers` is empty for `auth: none`, the opened header
 * map for `auth: headers`, and a fresh `Authorization` for `auth: oauth`. It is **not** stored
 * anywhere by this service — the caller holds it for the request only.
 */
export interface ResolvedMcpServer {
  /** The resource, for the tool loop to read the name, the tool summaries and the status. */
  readonly server: McpServer
  /** The Streamable HTTP endpoint. */
  readonly url: string
  /** The headers a request to `url` carries. Never logged. */
  readonly headers: Readonly<Record<string, string>>
}

/**
 * A completed OAuth callback: the server that was connected, and where the flow was started.
 *
 * The route answers a browser, not an API caller, and the two origins want different endings —
 * the app is redirected to its settings screen, the CLI (which opened the authorization URL in
 * the system browser and is waiting on its own terminal) is shown a page to close — so the
 * origin the `state` recorded travels back with the server (#311).
 */
export interface CompletedMcpOAuth {
  /** The server the flow connected, with the tools its check just listed. */
  readonly server: McpServer
  /** Where the flow was started: the web app, or the CLI. */
  readonly client: McpOAuthClient
}

/** How {@link createMcpServerService} is wired. */
export interface McpServerServiceOptions {
  /** Where the servers and their sealed secrets live. */
  readonly store: McpServerStore
  /** The vault that seals and opens them; the same one provider credentials use. */
  readonly vault: Vault
  /** The guarded fetch every outbound request goes through (a `safeFetch` wrapper). */
  readonly fetch: McpFetch
  /** The absolute URL of this server's OAuth callback route, registered at the provider. */
  readonly callbackUrl: string
  /** The clock, for timestamps and token expiry; injectable for tests. */
  readonly now?: () => Date
  /** The OAuth client name announced in dynamic registration. */
  readonly clientName?: string
  /** How long one MCP request may take. */
  readonly checkTimeoutMs?: number
  /** Where refresh failures and check errors are logged. Silent by default. */
  readonly logger?: Logger
}

/** The MCP server operations the routes and the tool loop use. */
export interface McpServerService {
  /** Create a server: seal its secrets, run the save-time check, store it. 409 on a name the caller has. */
  create(userId: UserId, body: CreateMcpServerRequest): Promise<McpServer>
  /** The caller's own servers, oldest first. */
  list(userId: UserId): Promise<McpServer[]>
  /** One own server, or `null` for an unknown id and another user's alike. */
  get(userId: UserId, serverId: McpServerId): Promise<McpServer | null>
  /** Apply a patch; `null` when the id is not the caller's. 400 for a body its auth cannot take. */
  update(
    userId: UserId,
    serverId: McpServerId,
    body: UpdateMcpServerRequest,
  ): Promise<McpServer | null>
  /** Delete a server and its pending OAuth states; `false` when it is not the caller's. */
  delete(userId: UserId, serverId: McpServerId): Promise<boolean>
  /** Run the connection check now and return the refreshed server; `null` for another owner's. */
  test(userId: UserId, serverId: McpServerId): Promise<McpServer | null>
  /**
   * Start the OAuth flow: discover, register, and answer the authorization URL.
   *
   * `client` records where the flow was started — the web app or the CLI — on the pending
   * `state`, because the callback is reached by a browser that may have no session here and the
   * state is the only thing it arrives with (#311).
   */
  connect(
    userId: UserId,
    serverId: McpServerId,
    client: McpOAuthClient,
  ): Promise<{ authorization_url: string } | null>
  /**
   * Complete the OAuth flow from the provider's callback (epic #303, X10; #311).
   *
   * The `state` is the authentication: it is high-entropy, single use, short-lived and bound to
   * the user and the server it was minted for, so the flow is completed for **that** user — the
   * callback needs no session (the browser `oh` opened may never have signed in). A session that
   * is present is only a defence against a confused flow: `sessionUserId` belonging to somebody
   * other than the state's user refuses the callback rather than completing it for the wrong
   * person. The state is consumed either way, so a refused callback cannot be retried.
   */
  completeCallback(
    params: { readonly code: string; readonly state: string },
    options?: { readonly sessionUserId?: UserId },
  ): Promise<CompletedMcpOAuth>
  /** Drop a server's OAuth tokens, leaving it `needs_reconnect`. */
  disconnect(userId: UserId, serverId: McpServerId): Promise<McpServer | null>
  /**
   * The URL and auth headers for one server (epic #303, X10; the seam #312 uses).
   *
   * Refreshes an OAuth token that is expired or about to expire, and marks the server
   * `needs_reconnect` — answering `null` — when there is no usable token. `forceRefresh`
   * refreshes even a token that looks live, which is what a caller does after a 401.
   */
  resolve(
    userId: UserId,
    serverId: McpServerId,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<ResolvedMcpServer | null>
  /** Every enabled server of a user that resolves right now, skipping the ones that cannot. */
  listEnabled(userId: UserId): Promise<ResolvedMcpServer[]>
  /** The absolute URL of this server's OAuth callback route, as registered at the provider. */
  readonly callbackUrl: string
}

/** The string a stored header map is sealed as. */
type HeaderMap = Record<string, string>

/** An {@link UpdateMcpServerInput} a caller may fill in field by field. */
type MutableUpdate = { -readonly [K in keyof UpdateMcpServerInput]: UpdateMcpServerInput[K] }

/** How long before an access token's expiry it is treated as needing a refresh. */
const REFRESH_SKEW_MS = 60_000

/** The default deadline for one MCP request (initialize + listTools). */
export const DEFAULT_MCP_CHECK_TIMEOUT_MS = 10_000

/** The OAuth `state` lifetime: long enough to sign in at the provider, short enough to be a nonce. */
export const MCP_OAUTH_STATE_TTL_MS = 10 * 60_000

/** Build the MCP server service. */
export function createMcpServerService(options: McpServerServiceOptions): McpServerService {
  const now = options.now ?? (() => new Date())
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_MCP_CHECK_TIMEOUT_MS
  const clientName = options.clientName ?? 'openharness'

  return new McpServerServiceImpl(
    options.store,
    options.vault,
    options.fetch,
    options.callbackUrl,
    {
      now,
      checkTimeoutMs,
      clientName,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
  )
}

/** The one implementation of {@link McpServerService}. */
class McpServerServiceImpl implements McpServerService {
  readonly #store: McpServerStore

  readonly #vault: Vault

  readonly #fetch: OAuthFetch

  readonly #callbackUrl: string

  readonly #now: () => Date

  readonly #checkTimeoutMs: number

  readonly #clientName: string

  readonly #logger: Logger | undefined

  constructor(
    store: McpServerStore,
    vault: Vault,
    fetch: OAuthFetch,
    callbackUrl: string,
    settings: {
      now: () => Date
      checkTimeoutMs: number
      clientName: string
      logger?: Logger
    },
  ) {
    this.#store = store
    this.#vault = vault
    this.#fetch = fetch
    this.#callbackUrl = callbackUrl
    this.#now = settings.now
    this.#checkTimeoutMs = settings.checkTimeoutMs
    this.#clientName = settings.clientName
    this.#logger = settings.logger
  }

  async create(userId: UserId, body: CreateMcpServerRequest): Promise<McpServer> {
    // The id is minted here, before anything is stored, because a secret is sealed under
    // associated data that names its server — so the server has to be known before its
    // headers are.
    const id = newMcpServerId(this.#now().getTime())
    const enabled = body.enabled ?? true
    const headerMap = body.auth === 'headers' ? body.headers : undefined
    const sealedHeaders =
      headerMap === undefined
        ? undefined
        : await sealMcpJson(this.#vault, binding(userId, id, 'headers'), headerMap)

    let status: McpServer['status'] = 'needs_reconnect'
    let lastError: string | null = null
    let tools: McpToolSummary[] = []
    let definitionTokens = 0
    let lastTestedAt: string | null = null

    if (body.auth !== 'oauth') {
      const outcome = await this.#checkAddressAndTools(body.url, headerMap ?? {})
      if (!outcome.ok) {
        if (outcome.refused) {
          throw invalidRequest(outcome.error)
        }
        status = 'error'
        lastError = outcome.error
      } else {
        status = 'connected'
        tools = outcome.tools.map(mcpToolSummary)
        definitionTokens = estimateToolsTokens(outcome.tools)
        lastTestedAt = this.#now().toISOString()
      }
    }

    return this.#store.create({
      id,
      ownerId: userId,
      name: body.name,
      url: body.url,
      auth: body.auth,
      enabled,
      status,
      lastError,
      headerNames: headerMap === undefined ? [] : Object.keys(headerMap),
      tools,
      definitionTokens,
      lastTestedAt,
      ...(sealedHeaders === undefined ? {} : { secrets: { headers: sealedHeaders } }),
    })
  }

  list(userId: UserId): Promise<McpServer[]> {
    return this.#store.list({ ownerId: userId })
  }

  async get(userId: UserId, serverId: McpServerId): Promise<McpServer | null> {
    const stored = await this.#store.get(serverId, { ownerId: userId })
    return stored === null ? null : metadataOf(stored)
  }

  async update(
    userId: UserId,
    serverId: McpServerId,
    body: UpdateMcpServerRequest,
  ): Promise<McpServer | null> {
    const current = await this.#store.get(serverId, { ownerId: userId })
    if (current === null) {
      return null
    }
    const auth = body.auth ?? current.auth
    const url = body.url ?? current.url
    const authChanged = auth !== current.auth
    const urlChanged = url !== current.url

    if (body.headers !== undefined && auth !== 'headers') {
      throw invalidRequest('`headers` may only be sent for a `headers`-authenticated server')
    }
    if (auth === 'headers' && body.headers === undefined && current.headers === undefined) {
      throw invalidRequest('a `headers`-authenticated server needs a `headers` map; none is stored')
    }

    const headerMap = await this.#headerMapForUpdate(userId, serverId, current, auth, body)
    const secrets: NonNullable<UpdateMcpServerInput['secrets']> = {
      // A new map replaces the stored one; a server that is no longer `headers` has none.
      headers:
        body.headers !== undefined
          ? await sealMcpJson(this.#vault, binding(userId, serverId, 'headers'), body.headers)
          : auth === 'headers'
            ? undefined
            : null,
      // Tokens survive a rename but not an auth or URL change: a token minted for one server is
      // not sent to another.
      tokens: auth !== 'oauth' ? null : authChanged || urlChanged ? null : undefined,
      // The registered client is kept across reconnects to the same server; a change of auth or
      // URL discards it so the next `connect` registers afresh.
      oauthClient: auth !== 'oauth' ? null : authChanged || urlChanged ? null : undefined,
    }

    const patch: MutableUpdate = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.url === undefined ? {} : { url: body.url }),
      ...(body.auth === undefined ? {} : { auth: body.auth }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      // The names a list shows follow the map the server now sends: a replaced map has new
      // names, and a server that is no longer `headers` has none.
      headerNames: headerMap === null ? [] : Object.keys(headerMap),
      secrets,
    }

    if (auth === 'oauth') {
      if (authChanged || urlChanged) {
        patch.status = 'needs_reconnect'
        patch.lastError = null
      }
    } else {
      const outcome = await this.#checkAddressAndTools(url, headerMap ?? {})
      if (!outcome.ok) {
        if (outcome.refused) {
          throw invalidRequest(outcome.error)
        }
        patch.status = 'error'
        patch.lastError = outcome.error
        patch.tools = []
        patch.definitionTokens = 0
        patch.lastTestedAt = null
      } else {
        patch.status = 'connected'
        patch.lastError = null
        patch.tools = outcome.tools.map(mcpToolSummary)
        patch.definitionTokens = estimateToolsTokens(outcome.tools)
        patch.lastTestedAt = this.#now().toISOString()
      }
    }

    return this.#store.update(serverId, { ownerId: userId }, patch)
  }

  delete(userId: UserId, serverId: McpServerId): Promise<boolean> {
    return this.#store.delete(serverId, { ownerId: userId })
  }

  async test(userId: UserId, serverId: McpServerId): Promise<McpServer | null> {
    const stored = await this.#store.get(serverId, { ownerId: userId })
    if (stored === null) {
      return null
    }
    return this.#runAndStoreCheck(userId, stored, false)
  }

  async connect(
    userId: UserId,
    serverId: McpServerId,
    client: McpOAuthClient,
  ): Promise<{ authorization_url: string } | null> {
    const stored = await this.#store.get(serverId, { ownerId: userId })
    if (stored === null) {
      return null
    }
    if (stored.auth !== 'oauth') {
      throw invalidRequest(`server ${serverId} does not use OAuth; there is nothing to connect`)
    }
    const resource = await discoverResource(this.#fetch, stored.url)
    const issuer = resource.authorization_servers[0]
    if (issuer === undefined) {
      throw new McpOAuthError(`${stored.url} advertises no authorization server`)
    }
    const metadata = await discoverAuthorizationServer(this.#fetch, issuer)
    const existing = await this.#openRegistration(userId, stored)
    const registration: OAuthClientRegistration =
      existing !== null && existing.authorization_endpoint === metadata.authorization_endpoint
        ? existing
        : {
            ...(await registerClient(this.#fetch, metadata, {
              redirectUri: this.#callbackUrl,
              clientName: this.#clientName,
            })),
            authorization_endpoint: metadata.authorization_endpoint,
            token_endpoint: metadata.token_endpoint,
            ...(metadata.issuer === undefined ? {} : { issuer: metadata.issuer }),
            ...(resource.scopes_supported === undefined
              ? {}
              : { scopes: resource.scopes_supported }),
          }
    // Persisted now, so the callback needs no discovery of its own and a reconnect reuses the
    // registration rather than registering this server again.
    await this.#store.update(
      serverId,
      { ownerId: userId },
      {
        secrets: {
          oauthClient: await sealMcpJson(
            this.#vault,
            binding(userId, serverId, 'oauth_client'),
            registration,
          ),
        },
        status: 'needs_reconnect',
        lastError: null,
      },
    )
    const pkce = createPkce()
    const state = newState()
    await this.#store.createOAuthState({
      state,
      userId,
      serverId,
      codeVerifier: pkce.verifier,
      client,
      expiresAt: new Date(this.#now().getTime() + MCP_OAUTH_STATE_TTL_MS).toISOString(),
    })
    return {
      authorization_url: authorizationUrl(metadata, {
        clientId: registration.client_id,
        redirectUri: this.#callbackUrl,
        state,
        challenge: pkce.challenge,
        resource: stored.url,
        ...(registration.scopes === undefined ? {} : { scopes: registration.scopes }),
      }),
    }
  }

  async completeCallback(
    params: { readonly code: string; readonly state: string },
    options: { readonly sessionUserId?: UserId } = {},
  ): Promise<CompletedMcpOAuth> {
    const pending = await this.#store.consumeOAuthState(params.state)
    if (pending === null) {
      throw invalidRequest(
        'this authorization is unknown, expired or already used; start the connection again',
      )
    }
    // The state authenticates the callback. A session is not required — the browser `oh` opened
    // may never have signed in here — but one that is present and belongs to somebody else is a
    // confused flow: the state is bound to the user who started it, and completing it would
    // hand this session the tokens. Consuming the state above means the refused flow is over.
    if (options.sessionUserId !== undefined && options.sessionUserId !== pending.userId) {
      throw invalidRequest(
        'this authorization was started by another user; start the connection again',
      )
    }
    const userId = pending.userId
    const stored = await this.#store.get(pending.serverId, { ownerId: userId })
    if (stored === null) {
      throw invalidRequest('the server this authorization was for no longer exists')
    }
    const registration = await this.#openRegistration(userId, stored)
    if (registration === null) {
      throw invalidRequest('this server has no registered OAuth client; start the connection again')
    }
    const tokens = await exchangeAuthorizationCode(
      this.#fetch,
      { token_endpoint: registration.token_endpoint },
      {
        code: params.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: this.#callbackUrl,
        clientId: registration.client_id,
        ...(registration.client_secret === undefined
          ? {}
          : { clientSecret: registration.client_secret }),
        resource: stored.url,
        now: this.#now,
      },
    )
    await this.#store.update(
      pending.serverId,
      { ownerId: userId },
      {
        secrets: {
          tokens: await sealMcpJson(this.#vault, binding(userId, stored.id, 'tokens'), tokens),
        },
        status: 'connected',
        lastError: null,
      },
    )
    // List the tools straight away so the resource reports what the server offers, the same
    // shape a `test` leaves it in.
    const refreshed = await this.#store.get(pending.serverId, { ownerId: userId })
    if (refreshed === null) {
      throw invalidRequest('the server this authorization was for no longer exists')
    }
    return {
      server: await this.#runAndStoreCheck(userId, refreshed, false),
      client: pending.client,
    }
  }

  async disconnect(userId: UserId, serverId: McpServerId): Promise<McpServer | null> {
    const stored = await this.#store.get(serverId, { ownerId: userId })
    if (stored === null) {
      return null
    }
    return this.#store.update(
      serverId,
      { ownerId: userId },
      {
        secrets: { tokens: null },
        ...(stored.auth === 'oauth' ? { status: 'needs_reconnect', lastError: null } : {}),
      },
    )
  }

  async resolve(
    userId: UserId,
    serverId: McpServerId,
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<ResolvedMcpServer | null> {
    const stored = await this.#store.get(serverId, { ownerId: userId })
    if (stored === null) {
      return null
    }
    const headers = await this.#requestHeaders(userId, stored, options.forceRefresh === true)
    if (headers === null) {
      return null
    }
    return { server: metadataOf(stored), url: stored.url, headers }
  }

  get callbackUrl(): string {
    return this.#callbackUrl
  }

  async listEnabled(userId: UserId): Promise<ResolvedMcpServer[]> {
    const servers = await this.#store.list({ ownerId: userId })
    const resolved: ResolvedMcpServer[] = []
    for (const server of servers) {
      if (!server.enabled) {
        continue
      }
      const one = await this.resolve(userId, server.id)
      if (one !== null) {
        resolved.push(one)
      }
    }
    return resolved
  }

  // --------------------------------------------------------------- connection check

  /**
   * Run the connection check and write its outcome onto the server.
   *
   * A URL the guard refuses is a 400 — the request never happened and nothing is stored. Every
   * other failure is the server's `status: 'error'` with a scrubbed reason: a chat is never
   * blocked by an MCP server that is down (epic #303).
   */
  async #runAndStoreCheck(
    userId: UserId,
    stored: StoredMcpServer,
    forceRefresh: boolean,
  ): Promise<McpServer> {
    const headers = await this.#requestHeaders(userId, stored, forceRefresh)
    if (headers === null) {
      const updated = await this.#store.update(
        stored.id,
        { ownerId: userId },
        { status: 'needs_reconnect', lastError: null },
      )
      return updated ?? metadataOf(stored)
    }
    let outcome = await this.#checkAddressAndTools(stored.url, headers, secretValues(headers))
    // A token the server rejected is worth exactly one refresh: an OAuth access token can be
    // revoked before its stated expiry, and a 401 is the only signal of it.
    if (!outcome.ok && !outcome.refused && stored.auth === 'oauth' && isUnauthorized(outcome.raw)) {
      const refreshed = await this.#refreshTokens(userId, stored)
      if (refreshed !== null) {
        const refreshedHeaders = bearerHeaders(refreshed.access_token, refreshed.token_type)
        outcome = await this.#checkAddressAndTools(
          stored.url,
          refreshedHeaders,
          secretValues(refreshedHeaders),
        )
      }
    }
    if (outcome.ok) {
      const updated = await this.#store.update(
        stored.id,
        { ownerId: userId },
        {
          status: 'connected',
          lastError: null,
          tools: outcome.tools.map(mcpToolSummary),
          definitionTokens: estimateToolsTokens(outcome.tools),
          lastTestedAt: this.#now().toISOString(),
        },
      )
      return updated ?? metadataOf(stored)
    }
    if (outcome.refused) {
      throw invalidRequest(outcome.error)
    }
    const updated = await this.#store.update(
      stored.id,
      { ownerId: userId },
      { status: stored.auth === 'oauth' ? 'needs_reconnect' : 'error', lastError: outcome.error },
    )
    return updated ?? metadataOf(stored)
  }

  /**
   * Connect and list the tools, or classify the failure.
   *
   * A `SafeFetchError` refusal — a private address, a metadata host, a non-http scheme — is
   * flagged `refused`, which the caller turns into a 400; everything else is an ordinary
   * failure the server is left in `error` over.
   */
  async #checkAddressAndTools(
    url: string,
    headers: Record<string, string>,
    secrets: readonly string[] = [],
  ): Promise<CheckOutcome> {
    let session: Awaited<ReturnType<typeof openMcpClient>> | undefined
    try {
      session = await openMcpClient({
        url,
        headers,
        fetch: this.#fetch,
        timeoutMs: this.#checkTimeoutMs,
      })
      const tools = await session.listTools()
      return { ok: true, tools }
    } catch (error) {
      const refusal = findSafeFetchRefusal(error)
      if (refusal !== null) {
        return { ok: false, refused: true, error: refusal.message, raw: error }
      }
      return {
        ok: false,
        refused: false,
        error: describeCheckError(error, secrets),
        raw: error,
      }
    } finally {
      if (session !== undefined) {
        await session.close().catch(() => undefined)
      }
    }
  }

  // ------------------------------------------------------------------ auth headers

  /**
   * The headers a request to `stored` carries, or `null` when it has no usable credential.
   *
   * `none` is empty, `headers` is the opened map, and `oauth` is a fresh bearer token —
   * refreshed when it is missing, expired, about to expire, or when `forceRefresh` says so. A
   * refresh that fails marks the server `needs_reconnect`.
   */
  async #requestHeaders(
    userId: UserId,
    stored: StoredMcpServer,
    forceRefresh: boolean,
  ): Promise<Record<string, string> | null> {
    if (stored.auth === 'none') {
      return {}
    }
    if (stored.auth === 'headers') {
      if (stored.headers === undefined) {
        return null
      }
      const map = await openMcpJson<HeaderMap>(
        this.#vault,
        binding(userId, stored.id, 'headers'),
        stored.headers,
      )
      return map
    }
    const tokens =
      stored.tokens === undefined
        ? null
        : await openMcpJson<OAuthTokens>(
            this.#vault,
            binding(userId, stored.id, 'tokens'),
            stored.tokens,
          )
    if (tokens === null) {
      await this.#markNeedsReconnect(userId, stored)
      return null
    }
    if (forceRefresh || isExpiring(tokens, this.#now())) {
      const refreshed = await this.#refreshTokens(userId, stored, tokens)
      if (refreshed === null) {
        return null
      }
      return bearerHeaders(refreshed.access_token, refreshed.token_type)
    }
    return bearerHeaders(tokens.access_token, tokens.token_type)
  }

  /** Refresh an OAuth server's tokens and seal the new ones, or `null` on failure. */
  async #refreshTokens(
    userId: UserId,
    stored: StoredMcpServer,
    opened?: OAuthTokens,
  ): Promise<OAuthTokens | null> {
    const tokens =
      opened ??
      (stored.tokens === undefined
        ? null
        : await openMcpJson<OAuthTokens>(
            this.#vault,
            binding(userId, stored.id, 'tokens'),
            stored.tokens,
          ))
    const registration = await this.#openRegistration(userId, stored)
    if (tokens?.refresh_token === undefined || registration === null) {
      await this.#markNeedsReconnect(userId, stored)
      return null
    }
    try {
      const refreshed = await refreshAccessToken(
        this.#fetch,
        { token_endpoint: registration.token_endpoint },
        {
          refreshToken: tokens.refresh_token,
          clientId: registration.client_id,
          ...(registration.client_secret === undefined
            ? {}
            : { clientSecret: registration.client_secret }),
          now: this.#now,
        },
      )
      await this.#store.update(
        stored.id,
        { ownerId: userId },
        {
          secrets: {
            tokens: await sealMcpJson(this.#vault, binding(userId, stored.id, 'tokens'), refreshed),
          },
          status: 'connected',
          lastError: null,
        },
      )
      return refreshed
    } catch (error) {
      this.#logger?.warn('MCP token refresh failed', { server_id: stored.id })
      await this.#markNeedsReconnect(userId, stored, describeCheckError(error, []))
      return null
    }
  }

  /** Mark a server `needs_reconnect`, with a bounded reason. */
  async #markNeedsReconnect(
    userId: UserId,
    stored: StoredMcpServer,
    error?: string,
  ): Promise<void> {
    await this.#store.update(
      stored.id,
      { ownerId: userId },
      { status: 'needs_reconnect', lastError: error ?? null },
    )
  }

  /** The header map a patch leaves the server with, for the check that follows an update. */
  async #headerMapForUpdate(
    userId: UserId,
    serverId: McpServerId,
    current: StoredMcpServer,
    auth: McpServer['auth'],
    body: UpdateMcpServerRequest,
  ): Promise<Record<string, string> | null> {
    if (auth !== 'headers') {
      return null
    }
    if (body.headers !== undefined) {
      return body.headers
    }
    if (current.headers === undefined) {
      return null
    }
    return openMcpJson<HeaderMap>(
      this.#vault,
      binding(userId, serverId, 'headers'),
      current.headers,
    )
  }

  /** The registration stored for a server, or `null` when it has none. */
  async #openRegistration(
    userId: UserId,
    stored: StoredMcpServer,
  ): Promise<OAuthClientRegistration | null> {
    if (stored.oauthClient === undefined) {
      return null
    }
    return openMcpJson<OAuthClientRegistration>(
      this.#vault,
      binding(userId, stored.id, 'oauth_client'),
      stored.oauthClient,
    )
  }
}

/** The binding a secret is sealed under. */
function binding(
  userId: UserId,
  serverId: McpServerId,
  purpose: McpSecretBinding['purpose'],
): McpSecretBinding {
  return { userId, serverId, purpose }
}

/** A stored server's metadata, without the sealed blobs — the protocol's resource. */
function metadataOf(stored: StoredMcpServer): McpServer {
  const { headers: _headers, tokens: _tokens, oauthClient: _oauthClient, ...metadata } = stored
  return metadata
}

/** The `Authorization` header a bearer token rides on. */
function bearerHeaders(accessToken: string, tokenType: string): Record<string, string> {
  const scheme = tokenType.length === 0 ? 'Bearer' : tokenType
  return { Authorization: `${scheme} ${accessToken}` }
}

/** Whether an access token is expired or within {@link REFRESH_SKEW_MS} of expiring. */
function isExpiring(tokens: OAuthTokens, now: Date): boolean {
  if (tokens.expires_at === undefined) {
    return false
  }
  const expires = Date.parse(tokens.expires_at)
  return !Number.isFinite(expires) || expires - now.getTime() <= REFRESH_SKEW_MS
}

/** Every value a check sent, for scrubbing a server's echoed reason. */
function secretValues(headers: Record<string, string>): string[] {
  return Object.values(headers).filter((value) => value.length > 0)
}

/**
 * A short, secret-free description of a failed check.
 *
 * The server's own words where it has any, with every value this server sent — a header, a
 * bearer token — removed first: an error page that quotes the request must not turn into a
 * stored (or displayed) secret. Bounded to {@link MCP_LAST_ERROR_MAX_LENGTH}.
 */
function describeCheckError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : 'the connection failed'
  const scrubbed =
    secrets.length === 0
      ? message
      : secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), message)
  const reason = scrubbed.trim().length === 0 ? 'the connection failed' : scrubbed.trim()
  return reason.length > MCP_LAST_ERROR_MAX_LENGTH
    ? `${reason.slice(0, MCP_LAST_ERROR_MAX_LENGTH - 1)}…`
    : reason
}

/** Find a {@link SafeFetchError} anywhere in an error's cause chain, or `null`. */
function findSafeFetchRefusal(error: unknown): SafeFetchError | null {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (isSafeFetchError(current) && isRefusalCode(current.code)) {
      return current
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return null
}

/** The refusal codes of `safeFetch` — a URL this server will not fetch at all. */
function isRefusalCode(code: string): boolean {
  return (
    code === 'blocked_address' ||
    code === 'metadata_host' ||
    code === 'invalid_protocol' ||
    code === 'invalid_url'
  )
}

/** Whether an error is the transport's 401 (an OAuth access token the server rejected). */
function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  return (
    candidate.name === 'UnauthorizedError' ||
    candidate.code === 401 ||
    (typeof candidate.message === 'string' && candidate.message.includes('401'))
  )
}

/** A fresh, unguessable OAuth `state`. */
function newState(): string {
  return randomBytes(32).toString('base64url')
}
