import { createHash } from 'node:crypto'

import type {
  Agent,
  Metadata,
  Session,
  SessionStatus,
  StoredEvent,
  StreamOnlyEvent,
  Timestamp,
} from '@openharness/protocol'

import { timestampAt } from '../clock'
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

/** `agents`: an agent configuration. */
export interface AgentsTable {
  id: string
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
  processed_at: Date | null
}

/**
 * `session_previews`: the preview in flight for a session's current `agent.message`.
 *
 * One row per session at most. An `event_start` resets it — `event_id` and an empty `text` —
 * and an `event_delta` appends to `text` while it carries that same `event_id`; the row goes
 * inside the append transaction that stores the previewed event, or one carrying a
 * `span.model_request_end`. See `SessionStore.getPreview`.
 */
export interface SessionPreviewsTable {
  session_id: string
  /** The `sevt_` id the previewing `event_start` announced. */
  event_id: string
  /** Every delta text published for that id so far, concatenated in publish order. */
  text: string
  updated_at: Date
}

/** `partition_leases`: who holds a partition, at which epoch, until when. */
export interface PartitionLeasesTable {
  partition: number
  /** `null` when the partition is free; a released lease keeps its epoch. */
  owner: string | null
  epoch: number
  expires_at: Date | null
}

/** The database as this package sees it. */
export interface PostgresSchema {
  agents: AgentsTable
  sessions: SessionsTable
  events: EventsTable
  session_previews: SessionPreviewsTable
  partition_leases: PartitionLeasesTable
}

/** One row of `agents`. */
export type AgentRow = AgentsTable

/** One row of `sessions`. */
export type SessionRow = SessionsTable

/** One row of `events`. */
export type EventRow = EventsTable

/** One row of `partition_leases`. */
export type PartitionLeaseRow = PartitionLeasesTable

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
 * The stored event a row carries: the payload the caller sent, plus the three fields the
 * store assigns. `processed_at` is `null` on a user event that is still queued.
 */
export function eventFromRow(row: EventRow): StoredEvent {
  const payload = row.payload as AppendableEvent
  return {
    ...payload,
    id: row.id as StoredEvent['id'],
    seq: row.seq,
    processed_at: row.processed_at === null ? null : timestampOf(row.processed_at),
  } as StoredEvent
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
 * The largest `NOTIFY` payload Postgres accepts, with headroom.
 *
 * Postgres rejects a payload over 8000 bytes outright, which would abort the append
 * transaction that carried it, so the store checks the encoded size itself and drops what
 * would not fit (see {@link encodeEphemeralNotification}).
 */
export const NOTIFY_MAX_PAYLOAD_BYTES = 8000

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
 * The payload carrying an ephemeral event, or `null` when it does not fit in a notification.
 *
 * Ephemeral events are a preview of a stored event, not the record: they are delivered
 * best-effort, so one that exceeds {@link NOTIFY_MAX_PAYLOAD_BYTES} is dropped rather than
 * allowed to fail the publish. In practice only a `event_delta` carrying a very large chunk
 * can reach that size.
 */
export function encodeEphemeralNotification(event: StreamOnlyEvent): string | null {
  const payload = JSON.stringify(event)
  return Buffer.byteLength(payload, 'utf8') <= NOTIFY_MAX_PAYLOAD_BYTES ? payload : null
}

/** What a notification on a session's channel announces. */
export type SessionNotification =
  /** The log has events up to `seq`: fetch everything after the last one delivered. */
  | { readonly kind: 'stored'; readonly seq: number }
  /** An ephemeral event to hand to the session's subscribers as it is. */
  | { readonly kind: 'ephemeral'; readonly event: StreamOnlyEvent }

/**
 * Read a session-channel notification.
 *
 * A stored notification is `{"seq": n}` and an ephemeral one is the event itself — the two
 * are told apart by the one field the stream-only events do not have. `null` means the
 * payload is not something this store wrote, and is ignored.
 */
export function decodeSessionNotification(payload: string): SessionNotification | null {
  const decoded = asRecord(parseJson(payload))
  if (decoded === null) {
    return null
  }
  const seq = decoded.seq
  if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0) {
    return { kind: 'stored', seq }
  }
  return { kind: 'ephemeral', event: decoded as StreamOnlyEvent }
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
