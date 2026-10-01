/**
 * `@openharness/protocol` — the wire contract every other package codes against.
 *
 * It holds zod schemas and the TypeScript types inferred from them for the four things that
 * cross a boundary in openharness:
 *
 * - **resources** — `agent` and `session`, and the request/response bodies of the endpoints
 *   that manage them (`./resources`)
 * - **events** — the session log's vocabulary, its unions, and the events API (`./events`)
 * - **errors** — the Anthropic error envelope and its status codes (`./errors`)
 * - **ids and constants** — id generation and parsing, page cursors, header names, and the
 *   session → partition hash (`./ids`, `./pagination`, `./constants`)
 *
 * Everything here is pure: schemas, types and a few helpers, with `zod` as the only runtime
 * dependency and no I/O anywhere.
 *
 * The API follows Anthropic's Managed Agents API for the subset v1 supports. Every place
 * this package deviates from it or adds to it is marked `// extension:` at the definition and
 * listed in `AGENTS.md`.
 */

/** This package's name; a cheap way for a dependent to prove the import resolved. */
export const PACKAGE_NAME = '@openharness/protocol'

export * from './common'
export * from './constants'
export * from './content'
export * from './errors'
export * from './events'
export * from './ids'
export * from './pagination'
export * from './readonly'
export * from './resources'
