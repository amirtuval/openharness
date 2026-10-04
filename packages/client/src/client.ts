import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  GetMeResponseSchema,
  SendEventsResponseSchema,
} from '@openharness/protocol'
import type { User, UserEvent, UserInterruptEvent, UserMessageEvent } from '@openharness/protocol'

import type { DebugHook, FetchLike, ResponseSchema } from './http'
import { createTransport } from './http'
import { createAgentsResource, type AgentsResource } from './resources/agents'
import { createAuthResource, type AuthResource } from './resources/auth'
import { createModelsResource, type ModelsResource } from './resources/models'
import {
  createProviderCredentialsResource,
  type ProviderCredentialsResource,
} from './resources/provider-credentials'
import {
  createSessionsResource,
  sessionEventsPath,
  type SessionsResource,
} from './resources/sessions'

/**
 * The openharness client: typed access to the API, in a browser or in Node.
 *
 * ```ts
 * const client = createClient({ baseUrl: 'http://localhost:8787' }) // the web app: cookie auth
 * const cli = createClient({ baseUrl: 'http://localhost:8787', token }) // the CLI: bearer auth
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
 * only errors it throws for an answer from the server are {@link ApiError},
 * {@link AuthenticationError} (the 401 case of it) and {@link ResponseValidationError}.
 *
 * There are two ways to authenticate (epic #65, A2), and they are properties of *where* the
 * client runs, not of the calls it makes: a browser carries the web app's session cookie
 * automatically (`credentials: 'include'` on every request and on the SSE stream), and a
 * client given a `token` — the CLI — sends it as `Authorization: Bearer <token>`.
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
 *   token: 'oh_session_...', // the CLI; omit it in a browser, where the cookie authenticates
 *   fetch: myFetch,          // optional: defaults to the global fetch
 *   onDebug: (message) => console.debug(message),
 * })
 * ```
 */
export interface ClientOptions {
  /** Server root, e.g. `https://api.example.com`; a trailing slash is ignored. */
  baseUrl: string
  /**
   * Session token, sent as `Authorization: Bearer <token>` on every request, the SSE stream
   * included. This is the CLI's way in; a browser omits it and rides the session cookie that
   * every request carries (`credentials: 'include'`).
   */
  token?: string | undefined
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

  /** The caller's model-provider credentials (epic #65, A5); write-only. */
  readonly providerCredentials: ProviderCredentialsResource

  /**
   * The model catalog (epic #92): the chat models the caller's stored provider keys can use.
   *
   * `models.list()` is `GET /v1/models`; `list({ refresh: true })` bypasses the server's
   * one-hour cache and re-fetches, rate-limited to once a minute per user.
   */
  readonly models: ModelsResource

  /** Signing in (the CLI's device flow) and signing out (epic #65, A6). */
  readonly auth: AuthResource

  /**
   * The signed-in user: `GET /v1/me`.
   *
   * The identity every request is scoped to, and the proof the CLI has a usable token —
   * `oh whoami` and `oh login` (print `Logged in as <email>`) both end here.
   *
   * @param options request options (cancellation)
   * @throws AuthenticationError when the caller has no valid session
   */
  me(options?: RequestOptions): Promise<User>

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
    token: options.token,
    fetch: options.fetch,
    debug: options.onDebug,
  })

  return {
    agents: createAgentsResource(transport),
    sessions: createSessionsResource(transport),
    providerCredentials: createProviderCredentialsResource(transport),
    models: createModelsResource(transport),
    auth: createAuthResource(transport),

    me(requestOptions) {
      return transport.json(GetMeResponseSchema, {
        method: 'GET',
        path: `${API_VERSION_PREFIX}/me`,
        signal: requestOptions?.signal,
      })
    },

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
