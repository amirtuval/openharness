import { PACKAGE_NAME as HANDS_PACKAGE_NAME } from '@openharness/hands'
import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'
import { PACKAGE_NAME as SESSION_PACKAGE_NAME } from '@openharness/session'

/**
 * `@openharness/brain` — the stateless harness loop.
 *
 * A turn is one call to {@link runTurn}: it reads the session log, streams a reply from the
 * model, and appends what happened to the log. Nothing is remembered between turns — the log
 * is the state — which is what lets a crashed turn be resumed by another process and two
 * brains never share a session. Scheduling, ownership, HTTP and storage live outside this
 * package; the brain only sees a `SessionStore`, a model and an abort signal.
 *
 * - **{@link runTurn}** (`./turn`) — the loop, and the lifecycle it writes.
 * - **{@link ContextStrategy}** (`./context`) — how the log becomes model messages: the latest
 *   non-superseded `session.context_summary` replaces the history it covers (epic #277, K1), and
 *   an oversized newest item is capped rather than dropped (K6).
 * - **{@link estimateNextRequestTokens}** (`./context`) — how big the next request will be, from
 *   the previous request's real prompt size plus an estimate for what is new (epic #277, K2).
 * - **{@link summarizeContext}** (`./summarize`) — the compaction engine: at a request boundary,
 *   older history is summarized so the chat fits its model's window (epic #277, C2; #279).
 * - **{@link PROVIDER_REASONING}** (`./reasoning`) — how `low | medium | high` is asked for from
 *   each provider, and what the log asked the next request to run with (#252).
 * - **{@link ModelFactory}** (`./model`) — how a `provider/model` id becomes a model to stream,
 *   made with the {@link ModelCredential} the request runs under.
 * - **{@link ResolveCredential}** (`./model`) — where that credential comes from: the session
 *   owner's own provider key, never the environment (epic #65, A5).
 * - **{@link redactSecret}** (`./redact`) — scrubbing a key out of provider error text.
 * - **{@link RetryPolicy}** (`./retry`) — how retryable failures are retried.
 * - **{@link classifyModelError}** (`./errors`) — retryable or terminal, and which
 *   `session.error` type says so.
 *
 * See `AGENTS.md` for the lifecycle diagram and the extension points.
 */

/** This package's name; a cheap way for a dependent to prove the import resolved. */
export const PACKAGE_NAME = '@openharness/brain'

/**
 * Proof that the brain → protocol / session / hands edges resolve through built output. Those
 * three packages must be built before this one.
 */
export const DEPENDENCIES = [
  PROTOCOL_PACKAGE_NAME,
  SESSION_PACKAGE_NAME,
  HANDS_PACKAGE_NAME,
] as const

export * from './context'
export * from './errors'
export * from './azure-fetch'
export * from './openai-compatible-fetch'
export * from './provider-fetch'
export * from './bedrock'
export * from './model'
export * from './reasoning'
export * from './redact'
export * from './retry'
export * from './manual'
export * from './summarize'
export * from './turn'
export * from './vertex'
