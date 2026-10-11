import type { Context } from 'hono'
import {
  type AgentId,
  AgentIdSchema,
  type McpServerId,
  McpServerIdSchema,
  type ModeId,
  ModeIdSchema,
  type SessionId,
  SessionIdSchema,
} from '@openharness/protocol'

import type { AppEnv } from '../types'
import type { ValidationIssue } from './errors'
import { invalidRequest, validationError } from './errors'

/**
 * Reading a request the way the protocol describes it: bodies and queries validated by the
 * protocol's schemas, path ids parsed with the protocol's branded id schemas.
 *
 * Nothing here imports `zod`. The protocol schemas are consumed structurally through
 * {@link SafeSchema}, which is the one method these helpers call, so a schema can be swapped
 * for another without this module knowing what produced it.
 */

/** What `safeParse` answers: the parsed value, or why it was refused. */
export type SchemaOutcome<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: readonly ValidationIssue[] } }

/** The part of a protocol schema this module uses. */
export interface SafeSchema<T> {
  safeParse(value: unknown): SchemaOutcome<T>
}

/**
 * Parse a JSON request body with a protocol schema.
 *
 * @throws HttpError 400 `invalid_request_error` when the body is not JSON, or when it does
 *   not match the schema
 */
export async function parseBody<T>(c: Context<AppEnv>, schema: SafeSchema<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw invalidRequest('the request body must be JSON')
  }
  return parseWith(schema, raw)
}

/**
 * Parse a body that may be absent, with a protocol schema.
 *
 * `POST …/connect` is the one route whose whole body is optional (#311): its `client` field
 * defaults, so a request that carries no body at all — which is what every caller sent before
 * the field existed — means the same thing as one that carries `{}`. An empty body parses as
 * the schema's own defaults; anything else has to be JSON and match, exactly like
 * {@link parseBody}.
 *
 * @throws HttpError 400 `invalid_request_error` when a non-empty body is not JSON, or when it
 *   does not match the schema
 */
export async function parseOptionalBody<T>(c: Context<AppEnv>, schema: SafeSchema<T>): Promise<T> {
  const text = await c.req.text()
  if (text.trim().length === 0) {
    return parseWith(schema, {})
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw invalidRequest('the request body must be JSON')
  }
  return parseWith(schema, raw)
}

/**
 * Parse the query string with a protocol schema.
 *
 * Array-valued parameters use the protocol's wire spelling: the key is repeated with a `[]`
 * suffix (`types[]=user.message&types[]=agent.message`), and the keys named in `arrayKeys`
 * are the ones collected into an array — a key whose name ends in `[]` is collected too, so
 * both spellings reach the endpoint the same way.
 *
 * @param arrayKeys query parameter names the protocol models as arrays
 * @throws HttpError 400 `invalid_request_error` when the query does not match the schema
 */
export function parseQuery<T>(
  c: Context<AppEnv>,
  schema: SafeSchema<T>,
  arrayKeys: readonly string[] = [],
): T {
  return parseWith(schema, queryObject(c, arrayKeys))
}

/**
 * Validate a path parameter that has to be an `agent_` id.
 *
 * A malformed id is a request the server cannot act on at all, so it is a 400 and not a 404:
 * it could not name an agent even if that agent existed.
 *
 * @throws HttpError 400 `invalid_request_error` when the parameter is not an `agent_` id
 */
export function agentIdParam(c: Context<AppEnv>, name: string): AgentId {
  return idParam(c.req.param(name), AgentIdSchema, name)
}

/** Validate a path parameter that has to be a `sesn_` id; see {@link agentIdParam}. */
export function sessionIdParam(c: Context<AppEnv>, name: string): SessionId {
  return idParam(c.req.param(name), SessionIdSchema, name)
}

/** Validate a path parameter that has to be a `mode_` id; see {@link agentIdParam}. */
export function modeIdParam(c: Context<AppEnv>, name: string): ModeId {
  return idParam(c.req.param(name), ModeIdSchema, name)
}

/** Validate a path parameter that has to be an `mcps_` id; see {@link agentIdParam}. */
export function mcpServerIdParam(c: Context<AppEnv>, name: string): McpServerId {
  return idParam(c.req.param(name), McpServerIdSchema, name)
}

/** A query parameter name as the array its `[]` spelling collects. */
export function arrayParam(name: string): string {
  return `${name}[]`
}

function idParam<T>(value: string | undefined, schema: SafeSchema<T>, name: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw invalidRequest(`the \`${name}\` path parameter must be a valid id`)
  }
  return parsed.data
}

function parseWith<T>(schema: SafeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw validationError(parsed.error)
  }
  return parsed.data
}

/**
 * The query string as the object a protocol query schema models.
 *
 * A key repeated with a `[]` suffix becomes an array of its values; every other key keeps
 * its first value. A parameter the schema does not know is dropped rather than refused, which
 * is the same rule the protocol's object schemas follow for unknown fields.
 */
function queryObject(c: Context<AppEnv>, arrayKeys: readonly string[]): Record<string, unknown> {
  const collected = c.req.queries()
  const query: Record<string, unknown> = {}
  for (const [key, values] of Object.entries(collected)) {
    const bracketed = key.endsWith('[]')
    const name = bracketed ? key.slice(0, -2) : key
    if (bracketed || arrayKeys.includes(name)) {
      query[name] = values
      continue
    }
    query[name] = values[0]
  }
  return query
}
