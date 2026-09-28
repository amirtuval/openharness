/**
 * `@openharness/client` — the typed SDK for the openharness API, for browsers and for Node.
 *
 * Four things live here:
 *
 * - **the client** — {@link createClient}, and the `Client` interface it and the fake client
 *   both implement: agents, sessions, the session event log, and helpers for sending a
 *   message and interrupting a turn;
 * - **streaming** — `client.sessions.events.stream`, an async iterable of `StreamEvent`s that
 *   reconnects and resumes by `seq`, so no stored event is delivered twice or skipped;
 * - **the transcript** — {@link createTranscript}, a pure reducer from those events to UI
 *   state, shared by the web app and the TUI;
 * - **errors** — {@link ApiError} for a non-2xx answer, built from the protocol's error
 *   envelope.
 *
 * Everything crossing the boundary is typed by `@openharness/protocol`, which owns the wire
 * contract; this package adds I/O, not schemas.
 *
 * `@openharness/client/testing` has `createFakeClient()` — the same interface, backed by an
 * in-memory server, with a scriptable brain.
 */

/** This package's name; lets a dependent prove the import resolved. */
export const PACKAGE_NAME = '@openharness/client'

export { createClient } from './client'
export type { Client, ClientOptions, RequestOptions } from './client'

export type { AgentsResource } from './resources/agents'
export type { SessionEventsResource, SessionsResource } from './resources/sessions'

export type { DebugHook, FetchLike } from './http'

export { ApiError, ResponseValidationError, errorTypeForStatus } from './errors'

export {
  createTranscript,
  initialTranscriptState,
  reduceTranscript,
  reduceTranscriptAll,
  selectIsRunning,
  selectLastMessage,
  selectMessages,
  selectStreamingMessage,
} from './transcript'
export type { Transcript, TranscriptError, TranscriptMessage, TranscriptState } from './transcript'

export type { StreamOptions } from './events/stream'
