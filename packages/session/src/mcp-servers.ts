import type {
  McpAuthType,
  McpServer,
  McpServerId,
  McpServerStatus,
  McpToolSummary,
  Timestamp,
  UserId,
} from '@openharness/protocol'

import type { SealedSecret } from './credentials'
import type { OwnerScope } from './store'

/**
 * The storage contract for users' **remote MCP servers** (epic #303, X10).
 *
 * A user registers the MCP servers they operate — a URL, how requests authenticate, whether
 * the server is on by default — and openharness stores them beside their provider credentials.
 * The secrets are **sealed before they get here**: the server encrypts the header map, the
 * OAuth tokens and the registered OAuth client with `@openharness/vault` and hands this store
 * a {@link SealedSecret}, which it writes down as it was given. The plaintext never reaches a
 * store, and this package deliberately has no dependency on the vault: the sealed shape is
 * restated (borrowed from {@link SealedSecret}) so the two are structurally interchangeable
 * without one importing the other.
 *
 * Two implementations exist: `InMemoryMcpServerStore` — the test fake — and
 * `PostgresMcpServerStore`, which lives behind `@openharness/session/postgres`.
 *
 * ## What every implementation must guarantee
 *
 * - **A name is unique per user.** {@link McpServerStore.create} refuses a second server with
 *   the same `(ownerId, name)`, raising `DuplicateMcpServerNameError`, and a user holds at most
 *   `MAX_MCP_SERVERS_PER_USER`, enforced by the store rather than only checked by the caller —
 *   so two concurrent creates cannot both take a name or the last slot. The count is taken
 *   inside the creating transaction under a per-owner lock, the way modes are.
 * - **Owner-scoped.** Every read and write is scoped to the owner's id; another user's server
 *   is `null` on a read and `false` on a delete, never a 403 and never a 500.
 * - **List is metadata only.** {@link McpServerStore.list} answers the protocol's `McpServer`
 *   with **no sealed secret in any shape** — implementations must not even select the sealed
 *   columns for it. Only {@link McpServerStore.get} hands the sealed form back, and only to the
 *   server code that opens it for one connection check or one OAuth refresh.
 * - **Deep-frozen answers.** What a store returns is deep-frozen, like the log's events and a
 *   credential: a sealed blob and the metadata beside it are values.
 * - **The OAuth state is single use and short-lived.** {@link McpServerStore.consumeOAuthState}
 *   removes the row and answers it only while it has not expired, so a callback replay finds
 *   nothing. Creating a state replaces any earlier one for the same `(user, server)`, which
 *   bounds how many an abandoned flow can leave behind.
 * - **Cascade.** A server belongs to its user record: deleting a `user` (Better Auth's `"user"`
 *   table) takes the user's servers, and a deleted server takes its pending OAuth states.
 *   In-memory stores have no users to delete, so those are the Postgres schema's foreign keys.
 */

/** The sealed secrets a server may carry. A key present means the secret is stored. */
export interface McpServerSecrets {
  /** The sealed JSON of a `headers`-authenticated server's name/value map. */
  readonly headers?: SealedSecret
  /** The sealed JSON of an `oauth` server's tokens (access token, refresh token, expiry). */
  readonly tokens?: SealedSecret
  /** The sealed JSON of the OAuth client this server registered (`client_id`, secret). */
  readonly oauthClient?: SealedSecret
}

/**
 * A server as {@link McpServerStore.get} returns it: the protocol's resource plus the sealed
 * secrets beside it.
 *
 * This type never appears in an API response — it is what the server reads to run a connection
 * check or a token refresh, and its sealed fields are what must never be logged or serialized
 * outward.
 */
export type StoredMcpServer = McpServer & McpServerSecrets

/** What {@link McpServerStore.create} writes. The store assigns `id` and the timestamps. */
export interface CreateMcpServerInput {
  /**
   * The server's `mcps_` id, when the caller mints it.
   *
   * The server mints it before the create so its secrets can be sealed under associated data
   * that names it (#311): the id has to be known before the row exists. Omitted, the store
   * mints one from its own clock, which is what a bare test does.
   */
  readonly id?: McpServerId
  /** The owner: the `user.id` Better Auth minted. */
  readonly ownerId: UserId
  /** The name, unique among the owner's servers. */
  readonly name: string
  /** The Streamable HTTP endpoint. */
  readonly url: string
  /** How requests authenticate. */
  readonly auth: McpAuthType
  /** Whether the server is on by default for this user's chats. */
  readonly enabled: boolean
  /** The health the create left it in. */
  readonly status: McpServerStatus
  /** Why the last check failed, or `null`. */
  readonly lastError: string | null
  /** The header names a `headers` server sends; `[]` for every other auth type. */
  readonly headerNames: readonly string[]
  /** The tools the create-time check listed; `[]` when no check ran. */
  readonly tools: readonly McpToolSummary[]
  /** The estimated token cost of `tools`. */
  readonly definitionTokens: number
  /** When the tools were listed, or `null`. */
  readonly lastTestedAt: Timestamp | null
  /** The sealed secrets to store. */
  readonly secrets?: McpServerSecrets
}

/**
 * What {@link McpServerStore.update} changes.
 *
 * Every field is optional and an omitted one keeps its stored value, the rule the mode update
 * follows. The secrets are the one place `null` is meaningful: an omitted key leaves the stored
 * blob alone (a rename does not re-seal a header map), a value replaces it, and `null` clears
 * it — which is what switching a server away from `headers` or `oauth` does.
 */
export interface UpdateMcpServerInput {
  readonly name?: string
  readonly url?: string
  readonly auth?: McpAuthType
  readonly enabled?: boolean
  readonly status?: McpServerStatus
  /** `undefined` keeps the stored value; `null` clears it. */
  readonly lastError?: string | null
  readonly headerNames?: readonly string[]
  readonly tools?: readonly McpToolSummary[]
  readonly definitionTokens?: number
  readonly lastTestedAt?: Timestamp | null
  /** `undefined` keeps each stored secret; a value replaces it; `null` clears it. */
  readonly secrets?: {
    readonly headers?: SealedSecret | null
    readonly tokens?: SealedSecret | null
    readonly oauthClient?: SealedSecret | null
  }
}

/**
 * One pending OAuth authorization, as {@link McpServerStore.createOAuthState} writes it.
 *
 * `state` is the opaque value echoed back by the authorization server and checked on the
 * callback; `codeVerifier` is the PKCE verifier its challenge was derived from. The verifier is
 * stored **in the clear**: it is a nonce for one round trip — useless once the code it is bound
 * to has been redeemed — rather than a durable credential, and the store has no vault to seal it
 * with. The access and refresh tokens that come out of the flow are sealed; this is not one.
 */
export interface McpOAuthStateInput {
  /** The opaque `state` the authorization server will echo back. */
  readonly state: string
  /** The user the flow belongs to; the callback must be the same user. */
  readonly userId: UserId
  /** The server being connected. */
  readonly serverId: McpServerId
  /** The PKCE code verifier. */
  readonly codeVerifier: string
  /** When the state stops being usable. */
  readonly expiresAt: Timestamp
}

/** A state {@link McpServerStore.consumeOAuthState} hands back: the fields the callback needs. */
export interface ConsumedMcpOAuthState {
  /** The user the flow was started by. */
  readonly userId: UserId
  /** The server being connected. */
  readonly serverId: McpServerId
  /** The PKCE verifier to send with the code exchange. */
  readonly codeVerifier: string
}

/** The storage contract for a user's remote MCP servers and their pending OAuth states. */
export interface McpServerStore {
  /**
   * Store a new server for its owner.
   *
   * @throws `DuplicateMcpServerNameError` when the owner already has a server with that name
   * @throws `McpServerLimitReachedError` when the owner is at `MAX_MCP_SERVERS_PER_USER`
   */
  create(input: CreateMcpServerInput): Promise<McpServer>

  /**
   * Read one server **including its sealed secrets**, or `null` when the id names no server of
   * this owner's.
   *
   * This is the one read that hands the sealed blobs back. It is for the server code that runs
   * a connection check, a token refresh or the OAuth callback; nothing else has any business
   * calling it, and nothing may log what it returns.
   */
  get(serverId: McpServerId, scope: OwnerScope): Promise<StoredMcpServer | null>

  /**
   * List one owner's servers, oldest first — `(created_at, id)` order, the order the mode and
   * agent lists use.
   *
   * Metadata only: no sealed field appears in an answer.
   */
  list(scope: OwnerScope): Promise<McpServer[]>

  /**
   * Apply a patch to one owner's server, or answer `null` for an id nobody's server has.
   *
   * @throws `DuplicateMcpServerNameError` when a rename collides with the owner's other servers
   */
  update(
    serverId: McpServerId,
    scope: OwnerScope,
    input: UpdateMcpServerInput,
  ): Promise<McpServer | null>

  /**
   * Delete one owner's server and its pending OAuth states.
   *
   * @returns `true` when one was deleted, `false` for an unknown id and another owner's server
   *   alike
   */
  delete(serverId: McpServerId, scope: OwnerScope): Promise<boolean>

  /**
   * Record a pending OAuth authorization, replacing any earlier one for the same
   * `(user, server)`.
   *
   * The replacement is what bounds an abandoned flow: a user who starts `connect` twice has one
   * pending state, not two, and the older one can no longer complete.
   */
  createOAuthState(input: McpOAuthStateInput): Promise<void>

  /**
   * Redeem a state: remove it and answer what the callback needs, or `null` when it is unknown,
   * expired or has already been used.
   *
   * Single use is the point — the row is deleted in the same call that reads it — and expiry is
   * checked against the store's injected clock.
   */
  consumeOAuthState(state: string): Promise<ConsumedMcpOAuthState | null>
}
