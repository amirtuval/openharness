import { EVENT_TYPES, SendEventsResponseSchema } from '@openharness/protocol'
import type { UserEvent, UserInterruptEvent, UserMessageEvent } from '@openharness/protocol'

import type { DebugHook, FetchLike, ResponseSchema } from './http'
import { createTransport } from './http'
import { createAgentsResource, type AgentsResource } from './resources/agents'
import {
  createSessionsResource,
  sessionEventsPath,
  type SessionsResource,
} from './resources/sessions'

/**
 * The openharness client: typed access to the API, in a browser or in Node.
 *
 * ```ts
 * const client = createClient({ baseUrl: 'http://localhost:8787', apiKey: 'oh_...' })
 *
 * const agent = await client.agents.create({
 *   name: 'Summarizer',
 *   model: { id: 'anthropic/claude-sonnet-5' },
 * })
 * const session = await client.sessions.create({ agent: agent.id })
 * const stored = await client.sendMessage(session.id, 'Summarize the README.')
 * ```
 *
 * The client holds no state of its own — the session log is the state — so one instance can
 * serve a whole app. Everything it returns is parsed against `@openharness/protocol`, and the
 * only errors it throws for an answer from the server are {@link ApiError} and
 * {@link ResponseValidationError}.
 */

/** What every method takes for cancellation. */
export interface RequestOptions {
  /** Aborts the request; the promise rejects with the abort reason. */
  signal?: AbortSignal | undefined
}

/**
 * Everything {@link createClient} needs.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   apiKey: 'oh_...',
 *   fetch: myFetch,          // optional: defaults to the global fetch
 *   onDebug: (message) => console.debug(message),
 * })
 * ```
 */
export interface ClientOptions {
  /** Server root, e.g. `https://api.example.com`; a trailing slash is ignored. */
  baseUrl: string
  /** Value of the `x-api-key` header; omitted when the server needs no auth. */
  apiKey?: string | undefined
  /**
   * The `fetch` to use; defaults to the global one.
   *
   * The seam exists for tests and for a runtime whose `fetch` lives somewhere else — a proxy,
   * a polyfill, a wrapper that adds tracing.
   */
  fetch?: FetchLike | undefined
  /**
   * Called for what the client tolerates rather than throws on: today, a stream event whose
   * type this client does not know. Ignored by default.
   */
  onDebug?: DebugHook | undefined
}

/**
 * The openharness API, as both the real client and the fake client implement it.
 *
 * `@openharness/client/testing`'s `createFakeClient()` returns one, so code written against
 * this interface runs unchanged against an in-memory server.
 */
export interface Client {
  /** The agent endpoints. */
  readonly agents: AgentsResource

  /** The session endpoints, including the session's event log. */
  readonly sessions: SessionsResource

  /**
   * Send a user message to a session and return it as stored.
   *
   * A shortcut for `sessions.events.send(sessionId, ...)`: one text block, and the stored
   * event back with the `id` and `seq` the server assigned. Its `processed_at` stays `null`
   * until the brain folds it into a turn — which is what the transcript shows as pending.
   *
   * @param sessionId the `sesn_` id
   * @param text the message body
   * @param options request options (cancellation)
   */
  sendMessage(sessionId: string, text: string, options?: RequestOptions): Promise<UserMessageEvent>

  /**
   * Ask a running session to stop.
   *
   * The model request in flight is cut short: the text it had produced so far is stored as an
   * `agent.message`, the span closes with an `interrupted` error, and the session goes idle.
   * Returns the stored `user.interrupt` event.
   *
   * @param sessionId the `sesn_` id
   * @param options request options (cancellation)
   */
  interrupt(sessionId: string, options?: RequestOptions): Promise<UserInterruptEvent>
}

/**
 * Create a client.
 *
 * @param options server URL, credentials, and the seams for tests
 */
export function createClient(options: ClientOptions): Client {
  const transport = createTransport({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetch: options.fetch,
    debug: options.onDebug,
  })

  return {
    agents: createAgentsResource(transport),
    sessions: createSessionsResource(transport),

    sendMessage(sessionId, text, requestOptions) {
      return transport.json(storedUserEventParser<UserMessageEvent>(EVENT_TYPES.userMessage), {
        method: 'POST',
        path: sessionEventsPath(sessionId),
        body: {
          events: [{ type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }],
        },
        signal: requestOptions?.signal,
      })
    },

    interrupt(sessionId, requestOptions) {
      return transport.json(storedUserEventParser<UserInterruptEvent>(EVENT_TYPES.userInterrupt), {
        method: 'POST',
        path: sessionEventsPath(sessionId),
        body: { events: [{ type: EVENT_TYPES.userInterrupt }] },
        signal: requestOptions?.signal,
      })
    },
  }
}

/**
 * A schema for "the response of sending one user event, as that stored event".
 *
 * The wire answers with the full envelope, but {@link Client.sendMessage} and
 * {@link Client.interrupt} promise the stored event itself, so the parser is composed rather
 * than reused: a response that does not carry it is a validation failure — reported with the
 * HTTP status the transport saw, which a second parse here could not know.
 *
 * @param type the event type that must come back
 */
function storedUserEventParser<T extends UserEvent>(type: T['type']): ResponseSchema<T> {
  return {
    safeParse(value) {
      const envelope = SendEventsResponseSchema.safeParse(value)
      if (!envelope.success) {
        return envelope
      }
      const stored = envelope.data.data.find((candidate) => candidate.type === type)
      if (stored === undefined) {
        return {
          success: false,
          error: { message: `The response does not contain the stored ${type}.` },
        }
      }
      // The schema's inferred type is the mutable spelling of the deep-readonly event (D9);
      // the envelope's value is the same shape, so this is the boundary cast between them.
      return { success: true, data: stored as unknown as T }
    },
  }
}
