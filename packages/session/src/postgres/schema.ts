import { createHash } from 'node:crypto'

import type {
  Agent,
  Metadata,
  ProviderCredential,
  Session,
  SessionStatus,
  StoredEvent,
  Timestamp,
} from '@openharness/protocol'
import type { ColumnType, Selectable } from 'kysely'

import { timestampAt } from '../clock'
import type { SealedProviderCredential } from '../credentials'
import { isUserEventType } from '../events'
import { deepFreeze } from '../freeze'
import type { AppendableEvent, PartitionSignal } from '../store'

/**
 * How the Postgres store's tables look to Kysely, and how a row becomes a protocol value.
 *
 * The types here are the database's, not the API's: `timestamptz` is a `Date` in and out of
 * `pg`, and a JSON column is whatever JSON was written. Everything a caller sees is built by
 * the `*FromRow` functions below, which is the one place the two representations meet.
 *
 * `id` columns are `text collate "C"`, so ordering and comparison in SQL are byte order —
 * the same order the protocol's keyset cursors use, which is what lets a cursor encoded over
 * one page seek into the next one in the database.
 */

/** `agents`: an agent configuration, owned by one user. */
export interface AgentsTable {
  id: string
  /** The `user.id` the agent belongs to (epic #65, A4); written once, never updated. */
  owner_id: string
  name: string
  description: string | null
  model_id: string
  system: string | null
  created_at: Date
  updated_at: Date
}

/** `sessions`: the header of a log, with the agent configuration it snapshotted. */
export interface SessionsTable {
  id: string
  /** The `user.id` the session belongs to (epic #65, A4); written once, never updated. */
  owner_id: string
  status: SessionStatus
  partition: number
  title: string | null
  metadata: Metadata
  agent_id: string
  agent_name: string
  agent_model_id: string
  agent_system: string | null
  created_at: Date
  updated_at: Date
}

/** `events`: one stored event of one session's log. */
export interface EventsTable {
  id: string
  session_id: string
  seq: number
  type: string
  /** The event body — an {@link AppendableEvent}, as the caller sent it. */
  payload: unknown
  created_at: Date
  /**
   * When the store wrote the event — for every event *except* a user event.
   *
   * A user event is queued, and its `processed_at` is derived on read from the claim that
   * takes it (see {@link eventFromRow}); since P4 the column is **never written** for one —
   * the append omits it, which the insert type below is what allows — and rows written before
   * that keep whatever they carry, which is what `0008_event_claims_backfill.sql` copied into
   * claim rows. A non-user event still reads its `processed_at` back from here.
   *
   * The update type is `never`: nothing updates this table after the insert.
   */
  processed_at: ColumnType<Date | null, Date | null | undefined, never>
}

/**
 * `event_claims`: which user events a turn has claimed, insert-only (D9, issue #46).
 *
 * A claim is a fact about a user event, never an edit of one: an event carrying `consumes`
 * writes a row here — a `span.model_request_start`, a `span.model_request_end` or a
 * `session.status_idle` (P4) — and nothing ever writes a claim twice or removes one. The
 * primary key on `event_id` is what makes claiming a claim: two writers racing for the same
 * event both insert, one commits and one does nothing. `claimed_by_event_id` names the event
 * that claimed this one; it is nullable only because rows written by the pre-P4
 * `markProcessed` carry `null`, and those are never rewritten. `claimed_at` is the injected
 * clock's instant at the claim, and is what a reader sees as the event's `processed_at` — the
 * `events.processed_at` column is the pre-D9 spelling of the same fact, is no longer read for
 * user events, and is never written for one.
 *
 * It carries no foreign keys on purpose (see `0007_event_claims.sql`): the log's tables are
 * truncated wholesale by test harnesses, and Postgres refuses to truncate a table a foreign
 * key points at.
 */
export interface EventClaimsTable {
  session_id: string
  /** The claimed `user.message` / `user.interrupt`; primary key, so a claim is made once. */
  event_id: string
  /** The event whose `consumes` claimed this one; `null` only on pre-P4 `markProcessed` rows. */
  claimed_by_event_id: string | null
  claimed_at: Date
}

/**
 * `event_supersessions`: the chunk ranges the log has replaced, insert-only (D9, issue #46).
 *
 * A reply is stored twice over — as the `event_start` / `event_delta` chunks it streamed in,
 * and as the finished `agent.message` (or, for a request that ended without one, the
 * `span.model_request_end`) — and the finished event carries `supersedes: { from_seq, to_seq }`
 * over the chunks it replaces. A row of this table is that range as recorded: the reader uses
 * it to skip the range on replay, and {@link SessionStore.compact} to delete it once it is
 * older than the retention window. It is never updated and never deleted; `by_seq` is the
 * superseding event's own `seq`, and the range always ends before it. Like `event_claims`, it
 * carries no foreign keys on purpose, so the log's tables stay truncatable in one statement.
 */
export interface EventSupersessionsTable {
  session_id: string
  /** The first replaced `seq` — the reply's `event_start`. */
  from_seq: number
  /** The last replaced `seq` — the reply's final `event_delta`. */
  to_seq: number
  /** The event that carries the range; primary key, so a range is recorded once. */
  by_event_id: string
  /** The superseding event's own `seq`; strictly after `to_seq`. */
  by_seq: number
  created_at: Date
}

/** `partition_leases`: who holds a partition, at which epoch, until when. */
export interface PartitionLeasesTable {
  partition: number
  /** `null` when the partition is free; a released lease keeps its epoch. */
  owner: string | null
  epoch: number
  expires_at: Date | null
}

/**
 * `provider_credentials`: one user's sealed model-provider key, per provider (epic #65, A5).
 *
 * The row is a sealed blob and the metadata around it — there is no plaintext column, and
 * none may ever be added (see `0013_provider_credentials.sql`). `unique (user_id, provider)`
 * is what makes `upsert` an upsert and what `list` seeks by; `on delete cascade` from
 * `"user"` takes a user's credentials with the user.
 */
export interface ProviderCredentialsTable {
  /** A `pcred_` id; kept across a replacement of the same `(user_id, provider)`. */
  id: string
  user_id: string
  provider: string
  type: string
  /** The sealed secret, field for field as the vault produced it. Opaque here. */
  ciphertext: string
  nonce: string
  wrapped_key: string
  kek_version: string
  /** The last four characters of the plaintext, for recognition only. */
  last4: string
  created_at: Date
  updated_at: Date
  validated_at: Date
}

/** The database as this package sees it. */
export interface PostgresSchema {
  agents: AgentsTable
  sessions: SessionsTable
  events: EventsTable
  event_claims: EventClaimsTable
  event_supersessions: EventSupersessionsTable
  partition_leases: PartitionLeasesTable
  provider_credentials: ProviderCredentialsTable
}

/** One row of `agents`. */
export type AgentRow = AgentsTable

/** One row of `sessions`. */
export type SessionRow = SessionsTable

/** One row of `events`, as a read returns it — the insert-side `undefined` resolved away. */
export type EventRow = Selectable<EventsTable>

/** One row of `event_claims`. */
export type EventClaimRow = EventClaimsTable

/** One row of `partition_leases`. */
export type PartitionLeaseRow = PartitionLeasesTable

/** One row of `provider_credentials`. */
export type ProviderCredentialRow = ProviderCredentialsTable

/** The columns a metadata read selects: every `provider_credentials` column but the sealed blob. */
export type ProviderCredentialMetadataRow = Pick<
  ProviderCredentialRow,
  'id' | 'type' | 'provider' | 'last4' | 'created_at' | 'updated_at' | 'validated_at'
>

/**
 * An `events` row as every read here fetches it: with the claim its event has, if any.
 *
 * `claimed_at` is what a user event's `processed_at` is derived from (see
 * {@link eventFromRow}), so a read that can return a user event joins `event_claims` — a
 * `left join`, so the column is `null` exactly when nothing has claimed the event.
 */
export type EventWithClaimRow = EventRow & { readonly claimed_at: Date | null }

/** A clock instant as a `timestamptz` parameter: the store never asks the database for time. */
export function instant(milliseconds: number): Date {
  return new Date(milliseconds)
}

/** A `timestamptz` value as the protocol writes timestamps: RFC 3339, UTC, milliseconds. */
export function timestampOf(value: Date): Timestamp {
  return timestampAt(value.getTime())
}

/** The `agent` resource a row carries. */
export function agentFromRow(row: AgentRow): Agent {
  return {
    id: row.id as Agent['id'],
    type: 'agent',
    owner_id: row.owner_id,
    name: row.name,
    description: row.description,
    model: { id: row.model_id },
    system: row.system,
    created_at: timestampOf(row.created_at),
    updated_at: timestampOf(row.updated_at),
  }
}

/** The `session` resource a row carries, with its snapshotted agent. */
export function sessionFromRow(row: SessionRow): Session {
  return {
    id: row.id as Session['id'],
    type: 'session',
    owner_id: row.owner_id,
    status: row.status,
    title: row.title,
    metadata: row.metadata,
    agent: {
      id: row.agent_id as Session['agent']['id'],
      name: row.agent_name,
      model: { id: row.agent_model_id },
      system: row.agent_system,
    },
    created_at: timestampOf(row.created_at),
    updated_at: timestampOf(row.updated_at),
  }
}

/**
 * The credential metadata a row carries: the `pcred_` id, the type and provider, the last
 * four characters and the timestamps — and never the sealed columns.
 *
 * The store deep-freezes what it hands out (see the `CredentialStore` contract), so this is
 * the one place a row becomes a value; a query that only lists metadata does not even select
 * the sealed columns, which is what makes "`list` never reads a secret" a property of the
 * SQL and not only of the mapping.
 */
export function credentialMetadataFromRow(row: ProviderCredentialMetadataRow): ProviderCredential {
  return deepFreeze({
    id: row.id as ProviderCredential['id'],
    type: row.type as ProviderCredential['type'],
    provider: row.provider,
    last4: row.last4,
    created_at: timestampOf(row.created_at),
    updated_at: timestampOf(row.updated_at),
    validated_at: timestampOf(row.validated_at),
  })
}

/** The sealed record a row carries: the metadata above plus the sealed blob, deep-frozen. */
export function credentialFromRow(row: ProviderCredentialRow): SealedProviderCredential {
  return deepFreeze({
    ...credentialMetadataFromRow(row),
    sealed: {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      wrappedKey: row.wrapped_key,
      kekVersion: row.kek_version,
    },
  })
}

/**
 * The stored event a row carries: the payload the caller sent, plus the three fields the
 * store assigns, with the fields the store derives filled in.
 *
 * Since D9 (issue #46) a user event's `processed_at` is derived, not stored: it is the
 * `claimed_at` of the claim the read joined in — `null` while nothing has claimed the event,
 * which is what "queued" means now. Every other event keeps the `processed_at` the store wrote
 * when it appended it. The event comes back deep-frozen: an event is immutable, and a copy
 * anything could write to would be a second log.
 */
export function eventFromRow(row: EventWithClaimRow): StoredEvent {
  const payload = row.payload as AppendableEvent
  const processed_at = isUserEventType(row.type)
    ? row.claimed_at === null
      ? null
      : timestampOf(row.claimed_at)
    : row.processed_at === null
      ? null
      : timestampOf(row.processed_at)
  return deepFreeze({
    ...payload,
    id: row.id as StoredEvent['id'],
    seq: row.seq,
    processed_at,
  }) as StoredEvent
}

// --------------------------------------------------------------------- channels

/**
 * Channel-name prefixes. A channel name is a Postgres identifier capped at 63 bytes, and a
 * session id is free-form text, so a session's channel is a hash of its id rather than the
 * id itself: `ohs_` plus 32 hex characters of SHA-256 is short, safe on every channel-name
 * path, and collides for two sessions with negligible probability.
 */
export const SESSION_CHANNEL_PREFIX = 'ohs_'

/** Prefix of the channel a partition's signals travel on. */
export const PARTITION_CHANNEL_PREFIX = 'ohp_'

/** The `LISTEN` channel a session's events are announced on. */
export function sessionChannel(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex')
  return SESSION_CHANNEL_PREFIX + digest.slice(0, 32)
}

/** The `LISTEN` channel a partition's signals are announced on. */
export function partitionChannel(partition: number): string {
  return `${PARTITION_CHANNEL_PREFIX}${partition}`
}

/** Whether a channel name is one this store listens on for a partition's signals. */
export function isPartitionChannel(channel: string): boolean {
  return channel.startsWith(PARTITION_CHANNEL_PREFIX)
}

// ----------------------------------------------------------------- notifications

/**
 * The payload announcing that a session's log has events up to `seq`.
 *
 * The event itself is not in the payload: a stored event is unbounded, a `NOTIFY` payload is
 * not. A subscriber that sees this fetches everything after the last `seq` it delivered,
 * which is also what makes coalesced or repeated notifications harmless.
 */
export function encodeStoredNotification(seq: number): string {
  return JSON.stringify({ seq })
}

/**
 * Read a session-channel notification; `null` means the payload is not something this store
 * wrote, and is ignored.
 *
 * A stored notification is `{"seq": n}`. Pre-P4 stores also announced ephemeral previews on
 * this channel — an event object, told apart by having no `seq` — and a payload shaped like
 * one is ignored rather than delivered, because the P4 store has no previews to deliver.
 */
export function decodeStoredNotification(payload: string): { readonly seq: number } | null {
  const decoded = asRecord(parseJson(payload))
  if (decoded === null) {
    return null
  }
  const seq = decoded.seq
  if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0) {
    return { seq }
  }
  return null
}

/** Read a partition-channel notification, or `null` when it is not a signal this store sent. */
export function decodePartitionNotification(payload: string): PartitionSignal | null {
  const decoded = asRecord(parseJson(payload))
  if (decoded === null) {
    return null
  }
  const { partition, sessionId, kind } = decoded
  if (typeof partition !== 'number' || typeof sessionId !== 'string') {
    return null
  }
  if (kind !== 'work' && kind !== 'interrupt') {
    return null
  }
  return { partition, sessionId: sessionId as PartitionSignal['sessionId'], kind }
}

/** The payload a partition signal travels in. */
export function encodePartitionNotification(signal: PartitionSignal): string {
  return JSON.stringify(signal)
}

/** `JSON.parse` as a total function: the caller has to narrow what comes back. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** A parsed JSON value seen as an object, or `null` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
