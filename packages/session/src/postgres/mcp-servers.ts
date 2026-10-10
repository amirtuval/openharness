import {
  MAX_MCP_SERVERS_PER_USER,
  newMcpServerId,
  type McpServer,
  type McpServerId,
} from '@openharness/protocol'
import { Kysely, PostgresDialect, sql, type Insertable, type Updateable } from 'kysely'
import { Pool } from 'pg'

import { type Clock, systemClock } from '../clock'
import { DuplicateMcpServerNameError, McpServerLimitReachedError } from '../errors'
import type { SealedSecret } from '../credentials'
import type {
  ConsumedMcpOAuthState,
  CreateMcpServerInput,
  McpOAuthStateInput,
  McpServerStore,
  StoredMcpServer,
  UpdateMcpServerInput,
} from '../mcp-servers'
import type { OwnerScope } from '../store'
import {
  instant,
  mcpServerFromMetadataRow,
  mcpServerFromRow,
  type McpServerRow,
  type McpServersTable,
  type PostgresSchema,
} from './schema'
import { isUniqueViolation } from './store'

/**
 * The Postgres `McpServerStore` (epic #303, X10): the durable implementation of the contract
 * in `mcp-servers.ts`, on the `mcp_servers` and `mcp_oauth_states` tables.
 *
 * It moves sealed blobs and metadata and opens nothing. The caller seals headers, tokens and
 * the OAuth client with `@openharness/vault` before a write and opens them after a `get`; this
 * store has no dependency on that package and treats each sealed column as an opaque JSON
 * value. A metadata read (`list`, and the answer to a write) selects every column but the three
 * sealed ones.
 *
 * `unique (owner_id, name)` is what makes a duplicate name a conflict rather than a race, and
 * the cap is a count then an insert under a per-owner `pg_advisory_xact_lock`, so two creates
 * racing for the last slot cannot both read a count below it — the rule modes established.
 *
 * Time comes from the injected clock: `created_at` and `updated_at` are written from it, never
 * from the database's `now()`, and an OAuth state's expiry is checked against it too.
 */
export class PostgresMcpServerStore implements McpServerStore {
  readonly #db: Kysely<PostgresSchema>

  readonly #pool: Pool

  /** Whether this store opened the pool: only then does {@link PostgresMcpServerStore.close} end it. */
  readonly #ownsPool: boolean

  readonly #clock: Clock

  #closed = false

  constructor(options: PostgresMcpServerStoreOptions = {}) {
    const { pool, connectionString } = options
    if (pool !== undefined && connectionString !== undefined) {
      throw new TypeError('pass either `pool` or `connectionString`, not both')
    }
    if (pool === undefined && connectionString === undefined) {
      throw new TypeError('pass either `pool` or `connectionString`')
    }
    if (pool !== undefined) {
      this.#pool = pool
      this.#ownsPool = false
    } else {
      this.#pool = new Pool({ connectionString })
      this.#ownsPool = true
    }
    this.#db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool: this.#pool }) })
    this.#clock = options.now ?? systemClock
  }

  async create(input: CreateMcpServerInput): Promise<McpServer> {
    const now = this.#clock()
    const at = instant(now)
    const row: Insertable<McpServersTable> = {
      id: input.id ?? newMcpServerId(now),
      owner_id: input.ownerId,
      name: input.name,
      url: input.url,
      auth: input.auth,
      enabled: input.enabled,
      status: input.status,
      last_error: input.lastError,
      header_names: JSON.stringify([...input.headerNames]),
      tools: JSON.stringify(input.tools.map((tool) => ({ ...tool }))),
      definition_tokens: input.definitionTokens,
      last_tested_at: input.lastTestedAt === null ? null : instant(Date.parse(input.lastTestedAt)),
      sealed_headers: sealedOf(input.secrets?.headers),
      sealed_tokens: sealedOf(input.secrets?.tokens),
      sealed_oauth_client: sealedOf(input.secrets?.oauthClient),
      created_at: at,
      updated_at: at,
    }
    return this.#db.transaction().execute(async (trx) => {
      // The per-owner lock first, so the count below and the insert it guards are one critical
      // section: two creates at the cap cannot both read a count below it and both insert.
      await sql`select pg_advisory_xact_lock(hashtext(${MCP_CREATE_LOCK + input.ownerId}))`.execute(
        trx,
      )
      const existing = await trx
        .selectFrom('mcp_servers')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('owner_id', '=', input.ownerId)
        .executeTakeFirstOrThrow()
      if (Number(existing.count) >= MAX_MCP_SERVERS_PER_USER) {
        throw new McpServerLimitReachedError(input.ownerId, MAX_MCP_SERVERS_PER_USER)
      }
      let saved: McpServerRow
      try {
        saved = await trx
          .insertInto('mcp_servers')
          .values(row)
          .returningAll()
          .executeTakeFirstOrThrow()
      } catch (error) {
        if (isUniqueViolation(error, MCP_SERVER_NAME_CONSTRAINTS)) {
          throw new DuplicateMcpServerNameError(input.ownerId, input.name)
        }
        throw error
      }
      return mcpServerFromMetadataRow(saved)
    })
  }

  async get(serverId: McpServerId, options: OwnerScope): Promise<StoredMcpServer | null> {
    const row = await this.#db
      .selectFrom('mcp_servers')
      .selectAll()
      .where('id', '=', serverId)
      .where('owner_id', '=', options.ownerId)
      .executeTakeFirst()
    return row === undefined ? null : mcpServerFromRow(row)
  }

  async list(options: OwnerScope): Promise<McpServer[]> {
    // The metadata columns only: a list never reads a sealed cell. `(created_at, id)` is the
    // order every resource list uses, and the index in the migration seeks by it.
    const rows = await this.#db
      .selectFrom('mcp_servers')
      .select(METADATA_COLUMNS)
      .where('owner_id', '=', options.ownerId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mcpServerFromMetadataRow)
  }

  async update(
    serverId: McpServerId,
    options: OwnerScope,
    input: UpdateMcpServerInput,
  ): Promise<McpServer | null> {
    return this.#db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('mcp_servers')
        .select(['owner_id', 'name'])
        .where('id', '=', serverId)
        .where('owner_id', '=', options.ownerId)
        .executeTakeFirst()
      if (current === undefined) {
        return null
      }
      const changes: Updateable<McpServersTable> = {
        updated_at: instant(this.#clock()),
      }
      if (input.name !== undefined) changes.name = input.name
      if (input.url !== undefined) changes.url = input.url
      if (input.auth !== undefined) changes.auth = input.auth
      if (input.enabled !== undefined) changes.enabled = input.enabled
      if (input.status !== undefined) changes.status = input.status
      if (input.lastError !== undefined) changes.last_error = input.lastError
      if (input.headerNames !== undefined) {
        changes.header_names = JSON.stringify([...input.headerNames])
      }
      if (input.tools !== undefined) {
        changes.tools = JSON.stringify(input.tools.map((tool) => ({ ...tool })))
      }
      if (input.definitionTokens !== undefined) changes.definition_tokens = input.definitionTokens
      if (input.lastTestedAt !== undefined) {
        changes.last_tested_at =
          input.lastTestedAt === null ? null : instant(Date.parse(input.lastTestedAt))
      }
      // A patched secret replaces the stored blob, `null` clears it, and an omitted key leaves
      // it alone — "keep" is the key's absence from the `set` object.
      if (input.secrets?.headers !== undefined) {
        changes.sealed_headers = sealedOrNull(input.secrets.headers)
      }
      if (input.secrets?.tokens !== undefined) {
        changes.sealed_tokens = sealedOrNull(input.secrets.tokens)
      }
      if (input.secrets?.oauthClient !== undefined) {
        changes.sealed_oauth_client = sealedOrNull(input.secrets.oauthClient)
      }
      try {
        const row = await trx
          .updateTable('mcp_servers')
          .set(changes)
          .where('id', '=', serverId)
          .where('owner_id', '=', options.ownerId)
          .returning(METADATA_COLUMNS)
          .executeTakeFirstOrThrow()
        return mcpServerFromMetadataRow(row)
      } catch (error) {
        if (isUniqueViolation(error, MCP_SERVER_NAME_CONSTRAINTS)) {
          throw new DuplicateMcpServerNameError(current.owner_id, input.name ?? current.name)
        }
        throw error
      }
    })
  }

  async delete(serverId: McpServerId, options: OwnerScope): Promise<boolean> {
    // The states cascade (`on delete cascade`), so this one statement is the whole delete.
    const deleted = await this.#db
      .deleteFrom('mcp_servers')
      .where('id', '=', serverId)
      .where('owner_id', '=', options.ownerId)
      .executeTakeFirst()
    return Number(deleted.numDeletedRows) > 0
  }

  async createOAuthState(input: McpOAuthStateInput): Promise<void> {
    const at = instant(this.#clock())
    await this.#db.transaction().execute(async (trx) => {
      // One pending flow per `(user, server)`: a second `connect` replaces the first, so an
      // abandoned flow cannot leave a second usable state behind.
      await trx
        .deleteFrom('mcp_oauth_states')
        .where('user_id', '=', input.userId)
        .where('server_id', '=', input.serverId)
        .execute()
      await trx
        .insertInto('mcp_oauth_states')
        .values({
          state: input.state,
          user_id: input.userId,
          server_id: input.serverId,
          code_verifier: input.codeVerifier,
          created_at: at,
          expires_at: instant(Date.parse(input.expiresAt)),
        })
        .execute()
    })
  }

  async consumeOAuthState(state: string): Promise<ConsumedMcpOAuthState | null> {
    // Delete-and-return in one statement: a callback replay cannot find a row that is already
    // gone, whatever the expiry says.
    const row = await this.#db
      .deleteFrom('mcp_oauth_states')
      .where('state', '=', state)
      .returningAll()
      .executeTakeFirst()
    if (row === undefined || row.expires_at.getTime() <= this.#clock()) {
      return null
    }
    return {
      userId: row.user_id,
      serverId: row.server_id as McpServerId,
      codeVerifier: row.code_verifier,
    }
  }

  /**
   * Give up the store's own resources: end the pool when this store opened it.
   *
   * A store built on a pool the caller owns leaves that pool alone. Idempotent, and nothing
   * else may be called afterwards.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    if (this.#ownsPool) {
      await this.#db.destroy()
    }
  }
}

/** Everything {@link PostgresMcpServerStore} takes. */
export interface PostgresMcpServerStoreOptions {
  /** A connection string this store opens (and, on {@link PostgresMcpServerStore.close}, ends) itself. */
  readonly connectionString?: string
  /** A pool to borrow. The store never ends it; the caller owns its lifecycle. */
  readonly pool?: Pool
  /**
   * The store's time source. Defaults to {@link systemClock}; pass a controllable clock in
   * tests, which is what the conformance suite does.
   */
  readonly now?: Clock
}

/** How the two ways of reaching Postgres are written: a connection string, or a pool. */
export type PostgresMcpServerStoreConfig =
  { readonly connectionString: string } | { readonly pool: Pool }

/**
 * Build a Postgres-backed MCP server store.
 *
 * ```ts
 * const store = createPostgresMcpServerStore({ connectionString: process.env.DATABASE_URL })
 * ```
 *
 * The tables have to exist: run {@link migrate} against the same database first — the same
 * migrations the session store applies.
 */
export function createPostgresMcpServerStore(
  config: PostgresMcpServerStoreConfig,
  options: Omit<PostgresMcpServerStoreOptions, 'connectionString' | 'pool'> = {},
): PostgresMcpServerStore {
  return new PostgresMcpServerStore({ ...config, ...options })
}

/** The columns a metadata read selects: the resource's fields, never the sealed blobs. */
const METADATA_COLUMNS = [
  'id',
  'owner_id',
  'name',
  'url',
  'auth',
  'enabled',
  'status',
  'last_error',
  'header_names',
  'tools',
  'definition_tokens',
  'last_tested_at',
  'created_at',
  'updated_at',
] as const

/** The unique constraint behind a duplicate-name refusal. */
const MCP_SERVER_NAME_CONSTRAINTS = new Set(['mcp_servers_owner_name_key'])

/** The advisory lock `create` takes, keyed by owner, so two users' creates never wait on each other. */
const MCP_CREATE_LOCK = 'openharness:mcp-server-create:'

/**
 * A sealed secret to store, as the JSON text its column holds, or `null` when there is none.
 *
 * Serialized here rather than left to `pg`: an object parameter happens to be stringified on
 * the way in, but relying on that makes an opaque encrypted blob's storage a property of the
 * driver's parameter handling. The column's `ColumnType` spells the insert side as text for
 * exactly this.
 */
function sealedOf(sealed: SealedSecret | undefined): string | null {
  return sealed === undefined ? null : JSON.stringify(sealed)
}

/** A patched sealed secret: its JSON text when there is one, `null` when the patch clears it. */
function sealedOrNull(sealed: SealedSecret | null): string | null {
  return sealed === null ? null : JSON.stringify(sealed)
}

export { MCP_CREATE_LOCK, MCP_SERVER_NAME_CONSTRAINTS }
