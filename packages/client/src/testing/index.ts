import {
  AgentSchema,
  CreateSessionRequestSchema,
  ListModelsResponseSchema,
  ProviderCredentialSchema,
  SessionSchema,
  UserPreferencesSchema,
  encodeKeyCursor,
  newAgentId,
  newProviderCredentialId,
  newSessionId,
  tryDecodePageCursor,
} from '@openharness/protocol'
import { makeAgent, makeModelEntry, makeSession, makeUser } from '@openharness/protocol/fixtures'
import type {
  Agent,
  GetPreferencesResponse,
  ListAgentsResponse,
  ListEventsResponse,
  ListModelsResponse,
  ListProviderCredentialsResponse,
  ListSessionsResponse,
  ModelEntry,
  ProviderCatalogStatus,
  ProviderCredential,
  SendEventsResponse,
  Session,
  SessionErrorType,
  StoredEvent,
  StreamEvent,
  User,
  UserEvent,
  UserEventInput,
  UserInterruptEvent,
  UserMessageEvent,
  UserPreferences,
} from '@openharness/protocol'

import { ApiError, AuthenticationError } from '../errors'
import type { Client, RequestOptions } from '../client'
import type { StreamOptions } from '../events/stream'
import { sleep } from '../internal/async'
import { DeviceLoginError } from '../resources/auth'
import type { DeviceLoginStart, PollDeviceLoginOptions } from '../resources/auth'
import { FakeBrain, clampLimit, type FakeScript } from './fake-brain'

export { FAKE_MODEL_USAGE } from './fake-brain'
export type { FakeFailure, FakeReply, FakeScript } from './fake-brain'

/**
 * The session token the fake's device flow hands out on approval.
 *
 * Returned by {@link AuthResource.pollDeviceLogin} exactly the way the server returns a real
 * one, so a CLI test can assert on what it stored.
 */
export const FAKE_SESSION_TOKEN = 'fake_session_token'

/**
 * Subpath export `@openharness/client/testing`: an in-memory server for tests.
 *
 * ```ts
 * import { createFakeClient } from '@openharness/client/testing'
 * import { createTranscript } from '@openharness/client'
 *
 * const fake = createFakeClient()
 * const transcript = createTranscript()
 *
 * fake.respondWith('Hello from the fake!', { chunks: 3 })
 * await fake.sendMessage(fake.session.id, 'Hi')
 *
 * for await (const event of fake.sessions.events.stream(fake.session.id, { deltas: true, afterSeq: 0 })) {
 *   transcript.apply(event)
 *   if (event.type === 'session.status_idle') break
 * }
 * ```
 *
 * The fake implements the same {@link Client} interface as `createClient`, and behaves the
 * way the server does: the same event order per turn, the same `seq` semantics, the same
 * `after_seq` backlog, the same resume rules, and the same error envelopes. Code that works
 * against the fake therefore works against the real API, which is what lets the web app and
 * the TUI test their components without a server.
 *
 * Authentication is simulated too (epic #65): the fake is signed in unless
 * {@link FakeClientOptions.authenticated} says otherwise, an unauthenticated one answers
 * every wire method with {@link AuthenticationError} the way a 401 answers, and
 * {@link FakeClient.scriptDeviceLogin} scripts the device flow `oh login` runs — pending
 * polls first, then approval, denial or expiry.
 *
 * What it does not do is simulate the network: a request never fails for transport reasons,
 * and `signal` aborts are honored at once rather than mid-flight.
 */

/** Options for {@link createFakeClient}. */
export interface FakeClientOptions {
  /** The one agent the fake starts with; a default agent when omitted. */
  agent?: Agent
  /** The one session the fake starts with; a default session on {@link agent} when omitted. */
  session?: Session
  /** The signed-in user the fake answers {@link Client.me} with; a default user when omitted. */
  user?: User
  /**
   * Whether the fake starts signed in; `true` by default.
   *
   * `false` puts every `/v1` method — the streams included — behind a 401: each rejects
   * with {@link AuthenticationError}, exactly as the server answers a request with no
   * session. The device flow is not one of those methods, so `oh login` can run against an
   * unauthenticated fake; approval signs it in.
   */
  authenticated?: boolean
  /**
   * Milliseconds between streamed events: 0 (the default) is as fast as the event loop
   * allows, a larger value makes a stream slow enough to interrupt or to render mid-flight.
   */
  delayMs?: number
  /**
   * The clock event timestamps come from; defaults to `() => new Date()`.
   *
   * Pass a counter to make a test's timestamps deterministic.
   */
  now?: () => Date
  /**
   * The model catalog {@link Client.models} lists, in place of the default one-entry catalog
   * (`makeModelEntry()`); served sorted by provider, then name, the way the server sorts it.
   */
  models?: readonly ModelEntry[]
  /**
   * The per-provider catalog statuses {@link Client.models} reports; defaults to an `ok`
   * status for every provider the configured {@link models} name.
   */
  providers?: readonly ProviderCatalogStatus[]
  /**
   * The preferences {@link Client.preferences} starts with, in place of the default
   * `{ default_model: null }` — the absence of a choice, like an account that never saved one.
   */
  preferences?: UserPreferences
}

/** A device flow, as {@link FakeClient.scriptDeviceLogin} takes it. */
export interface FakeDeviceFlowOptions {
  /**
   * What the user does at the verification page once the pending polls are over; defaults to
   * `'approved'`.
   *
   * `'approved'` resolves the poll with {@link FAKE_SESSION_TOKEN} and signs the fake in;
   * `'denied'` and `'expired'` reject it with a `DeviceLoginError` carrying that code.
   */
  outcome?: 'approved' | 'denied' | 'expired'
  /** How many polls answer `authorization_pending` before the outcome; defaults to 1. */
  pendingPolls?: number
  /**
   * The interval the flow reports and polls at, in seconds; defaults to 0, so tests never
   * wait. The fake sleeps between polls the way the real client does.
   */
  interval?: number
  /** The codes the fake reports; deterministic defaults when omitted. */
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  /** How long the codes stay valid, in seconds; defaults to 600 (Better Auth's ten minutes). */
  expiresIn?: number
}

/** A reply, as {@link FakeClient.respondWith} takes it. */
export interface FakeReplyOptions {
  /** The session to script for; defaults to the fake's own {@link FakeClient.session}. */
  sessionId?: string
  /**
   * How the preview is chunked: a count, or the exact fragments in order.
   *
   * A count spreads the text into that many pieces; the fragments concatenate back to the
   * whole reply, which is what the client's preview accumulation counts on.
   */
  chunks?: number | readonly string[]
  /** Milliseconds between deltas; overrides the client's `delayMs`. */
  delayMs?: number
}

/** A failure, as {@link FakeClient.failWith} takes it. */
export interface FakeFailureOptions {
  /** The session to script for; defaults to the fake's own {@link FakeClient.session}. */
  sessionId?: string
  /** The `session.error` type; defaults to `model_overloaded_error`. */
  type?: SessionErrorType
  /** The `session.error` message; a readable default per type when omitted. */
  message?: string
  /**
   * What the server is doing about it; defaults to `retrying`.
   *
   * `retrying` makes the fake emit `session.status_rescheduled`, start the request over and
   * move on to the next scripted step. `exhausted` and `terminal` end the turn.
   */
  retryStatus?: 'retrying' | 'exhausted' | 'terminal'
  /** Milliseconds before the failure arrives; overrides the client's `delayMs`. */
  delayMs?: number
}

/** One `models.list` call the fake answered, as {@link FakeClient.modelListCalls} records it. */
export interface ModelListCall {
  /** Whether the call asked to bypass the server's cache: `refresh: true`. */
  readonly refresh: boolean
}

/**
 * The fake client: a {@link Client} plus the scripting it needs to be a test double.
 *
 * Everything beyond the interface is about *setting the scene* — what the brain answers, how
 * slowly, and how it fails — and about reading back what the session log holds once a
 * scenario has run.
 */
export interface FakeClient extends Client {
  /**
   * The agent the fake starts with.
   *
   * A live view through the fake's own store, not the seed object: `fake.agent.name` reads
   * what the fake holds, so an update through {@link Client.agents} is visible here
   * immediately (issue #106).
   */
  readonly agent: Agent

  /**
   * The session the fake starts with.
   *
   * A live view through the fake's own store, like {@link agent}: `fake.session.status` and
   * `fake.session.model` read the current state, however it was reached — a turn, a scripted
   * flow, a message that switched the model.
   */
  readonly session: Session

  /**
   * The user the fake signs in as — the one {@link Client.me} answers once authenticated.
   *
   * A test can assert on exactly what the CLI would print, e.g. `fake.user.email`.
   */
  readonly user: User

  /**
   * Every {@link Client.models} call the fake has answered, in order, with its `refresh` flag.
   *
   * A component test asserts what the catalog asked the server for:
   *
   * ```ts
   * await fake.models.list({ refresh: true })
   * expect(fake.modelListCalls).toEqual([{ refresh: true }])
   * ```
   */
  readonly modelListCalls: readonly ModelListCall[]

  /**
   * Script the device flow `oh login` runs.
   *
   * The next {@link Client.auth} login answers the script; the codes it reports are
   * deterministic, and the interval defaults to 0 so no poll ever waits. Pending polls come
   * first, the outcome after:
   *
   * ```ts
   * const fake = createFakeClient({ authenticated: false })
   * fake.scriptDeviceLogin({ pendingPolls: 2, outcome: 'approved' })
   *
   * const start = await fake.auth.startDeviceLogin()
   * const token = await fake.auth.pollDeviceLogin(start.deviceCode) // FAKE_SESSION_TOKEN
   * // fake is signed in now: `await fake.me()` answers `fake.user`
   * ```
   *
   * @param options the outcome, how long the user takes, and the codes to report
   */
  scriptDeviceLogin(options?: FakeDeviceFlowOptions): FakeClient

  /**
   * Script a reply for the next model request.
   *
   * Calls queue up: the first reply answers the first request, the second the next one. With
   * nothing queued, the fake answers `Fake reply: <last user message>`.
   *
   * @param text the reply body
   * @param options which session, how to chunk the preview, and how slowly to stream it
   */
  respondWith(text: string, options?: FakeReplyOptions): FakeClient

  /**
   * Script a failure for the next model request.
   *
   * A `retrying` failure keeps the turn alive — `session.error`,
   * `session.status_rescheduled`, `session.status_running` — and the next scripted step
   * answers the retry, which is how "fails once, then succeeds" is written:
   *
   * ```ts
   * fake.failWith({ retryStatus: 'retrying' }).respondWith('Second time lucky.')
   * ```
   *
   * @param options the error to report, and how the server reacts to it
   */
  failWith(options?: FakeFailureOptions): FakeClient

  /**
   * Resolve once the session is idle — its turn, retries included, has finished.
   *
   * @param sessionId the session to wait for; defaults to {@link session}
   */
  waitForIdle(sessionId?: string): Promise<void>

  /**
   * The session's stored event log, in order.
   *
   * @param sessionId the session to read; defaults to {@link session}
   */
  history(sessionId?: string): readonly StoredEvent[]
}

/**
 * Create an in-memory client.
 *
 * @param options the seeded agent and session, and the streaming pace
 */
export function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const now = options.now ?? ((): Date => new Date())
  const delayMs = options.delayMs ?? 0

  const agents = new Map<string, Agent>()
  const brains = new Map<string, FakeBrain>()
  const credentials = new Map<string, ProviderCredential>()
  const user = options.user ?? makeUser()
  const models: readonly ModelEntry[] = options.models ?? [makeModelEntry()]
  const providers: readonly ProviderCatalogStatus[] =
    options.providers ??
    [...new Set(models.map((entry) => entry.provider))].map((provider) => ({
      provider,
      status: 'ok' as const,
      fetched_at: now().toISOString(),
      message: null,
    }))
  const modelListCalls: ModelListCall[] = []
  // The caller's settings (#111): one in-memory value, replaced whole by `put`, exactly like
  // the server's row behind `GET`/`PUT /v1/me/preferences`.
  let preferences: GetPreferencesResponse = UserPreferencesSchema.parse(
    options.preferences ?? { default_model: null },
  )
  let authenticated = options.authenticated ?? true
  let deviceFlow: FakeDeviceFlow | undefined

  /**
   * Refuse the way the server's 401 does.
   *
   * Every `/v1` method answers with this while the fake is signed out; the device flow and
   * the fake's own scripting do not, because the server's do not either.
   */
  const unauthenticated = (): Promise<never> =>
    Promise.reject(new AuthenticationError('Not signed in.'))

  /** The same refusal, for the synchronous call sites (the stream's first `next()`). */
  const requireAuthentication = (): void => {
    if (!authenticated) {
      throw new AuthenticationError('Not signed in.')
    }
  }

  /** The scripted device flow, or a default one: one pending poll, then approval. */
  const ensureDeviceFlow = (): FakeDeviceFlow => {
    deviceFlow ??= makeDeviceFlow({})
    return deviceFlow
  }

  const seedAgent = options.agent ?? makeAgent()
  agents.set(seedAgent.id, seedAgent)

  const seedSession =
    options.session ??
    makeSession({
      agent: {
        id: seedAgent.id,
        name: seedAgent.name,
        model: seedAgent.model,
        system: seedAgent.system,
      },
      // A session created from an agent runs the agent's configuration (issue #93): the
      // seeded session carries it beside the snapshot, the way `sessions.create` does.
      model: seedAgent.model,
      system: seedAgent.system,
    })
  brains.set(seedSession.id, new FakeBrain(seedSession, delayMs, now))

  /**
   * The brain of a session.
   *
   * Synchronous, because the fake's own helpers (scripting, reading the log) are not part of
   * the wire and should fail where they are called. The resource methods below go through
   * {@link requireBrain} instead, so that a client-interface call rejects the way a real
   * request would rather than throwing mid-expression.
   *
   * A deleted session (#111) is not found either: the session and its log are gone, and the
   * real routes answer exactly that 404 for it.
   */
  const brainFor = (sessionId: string): FakeBrain => {
    const brain = brains.get(sessionId)
    if (brain === undefined || brain.deleted) {
      throw new ApiError(404, `No session ${sessionId}.`, { type: 'not_found_error' })
    }
    return brain
  }

  const requireBrain = (sessionId: string): Promise<FakeBrain> => {
    const brain = brains.get(sessionId)
    return brain === undefined || brain.deleted
      ? Promise.reject(new ApiError(404, `No session ${sessionId}.`, { type: 'not_found_error' }))
      : Promise.resolve(brain)
  }

  const requireAgent = (agentId: string): Promise<Agent> => {
    const found = agents.get(agentId)
    return found === undefined
      ? Promise.reject(new ApiError(404, `No agent ${agentId}.`, { type: 'not_found_error' }))
      : Promise.resolve(found)
  }

  /** Queue a script on a session, so the next model request runs it. */
  const scriptOn = (sessionId: string, step: FakeScript): FakeClient => {
    brainFor(sessionId).script(step)
    return fake
  }

  const agentsResource: Client['agents'] = {
    create(body, requestOptions): Promise<Agent> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const timestamp = now().toISOString()
      const created = AgentSchema.parse({
        id: newAgentId(),
        type: 'agent',
        // Required since #61 (A4): every agent belongs to the signed-in user.
        owner_id: user.id,
        name: body.name,
        description: body.description ?? null,
        model: body.model,
        system: body.system ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      agents.set(created.id, created)
      return Promise.resolve(created)
    },

    get(agentId, requestOptions): Promise<Agent> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      return requireAgent(agentId)
    },

    list(params, requestOptions): Promise<ListAgentsResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const all = [...agents.values()].sort(byCreatedAtThenId)
      return Promise.resolve(pageByKey(all, params?.limit, params?.page, 'asc'))
    },

    async update(agentId, body, requestOptions): Promise<Agent> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const existing = await requireAgent(agentId)
      const updated: Agent = {
        ...existing,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.system === undefined ? {} : { system: body.system }),
        updated_at: now().toISOString(),
      }
      agents.set(agentId, updated)
      return Promise.resolve(updated)
    },
  }

  const eventsResource: Client['sessions']['events'] = {
    async send(sessionId, events, requestOptions): Promise<SendEventsResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const brain = await requireBrain(sessionId)
      const inputs = isEventList(events) ? events : [events]
      const stored: UserEvent[] = inputs.map((input) => brain.appendUserEvent(input))
      brain.startTurn()
      return Promise.resolve({ data: stored })
    },

    async list(sessionId, params, requestOptions): Promise<ListEventsResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const brain = await requireBrain(sessionId)
      return brain.pageEvents(params ?? {})
    },

    async *iterate(sessionId, params, requestOptions): AsyncIterable<StoredEvent> {
      let page = params?.page
      for (;;) {
        const response = await eventsResource.list(sessionId, { ...params, page }, requestOptions)
        yield* response.data
        const next = response.next_page
        if (next === null || next === page) {
          return
        }
        page = next
      }
    },

    stream(sessionId, streamOptions): AsyncIterable<StreamEvent> {
      // The lookup happens inside the generator, on the first `next()`: an unknown session —
      // or a signed-out caller — then fails the iteration rather than `stream()` itself, the
      // way a refused request does. It is also the moment the subscription is made, so no
      // event between the call and the first `next()` is missed.
      return streamFromBrain(() => {
        requireAuthentication()
        return brainFor(sessionId)
      }, streamOptions ?? {})
    },
  }

  const sessionsResource: Client['sessions'] = {
    async create(body, requestOptions): Promise<Session> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      // The server parses the body with the protocol's request schema — an agent and/or a
      // model, at least one — and answers 400 when it does not match, so the fake refuses the
      // same body the same way rather than storing a session that cannot run. `issue.message`
      // is what the server's error carries too, and what a UI shows: a readable sentence.
      const request = CreateSessionRequestSchema.safeParse(body)
      if (!request.success) {
        const issue = request.error.issues[0]
        const where =
          issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
        return Promise.reject(
          new ApiError(400, `${where}${issue?.message ?? 'the request is not valid'}`, {
            type: 'invalid_request_error',
          }),
        )
      }
      // The agent the session snapshots, when the request named one: an unknown id — or one
      // the fake's single user does not own — is the 404 an unknown agent gets.
      const agent = request.data.agent === undefined ? null : await requireAgent(request.data.agent)
      // What the session runs (issue #93): the request's model and system, or the agent's when
      // the request named none — the protocol's refinement guarantees one of the two exists.
      const timestamp = now().toISOString()
      const session = SessionSchema.parse({
        id: newSessionId(),
        type: 'session',
        // Required since #61 (A4); the same signed-in user the agent belongs to.
        owner_id: user.id,
        status: 'idle',
        title: request.data.title ?? null,
        metadata: request.data.metadata ?? {},
        // The schema's refinement says one of agent/model is always there, so this resolves:
        // the request's model, or the one the agent it named contributes.
        model: request.data.model ?? agent?.model,
        system: request.data.system === undefined ? (agent?.system ?? null) : request.data.system,
        agent:
          agent === null
            ? null
            : {
                id: agent.id,
                name: agent.name,
                model: agent.model,
                system: agent.system,
              },
        created_at: timestamp,
        updated_at: timestamp,
      })
      const brain = new FakeBrain(session, delayMs, now)
      brains.set(session.id, brain)
      const initialEvents = request.data.initial_events ?? []
      for (const input of initialEvents) {
        brain.appendUserEvent(input)
      }
      if (initialEvents.length > 0) {
        brain.startTurn()
      }
      return Promise.resolve(session)
    },

    async get(sessionId, requestOptions): Promise<Session> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const brain = await requireBrain(sessionId)
      return brain.session
    },

    list(params, requestOptions): Promise<ListSessionsResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const all = [...brains.values()]
        // A deleted session (#111) is gone, log and all: it is not listed any more.
        .filter((candidate) => !candidate.deleted)
        .map((candidate) => candidate.session)
        // A model-first session has no agent and no agent id to match (issue #93).
        .filter(
          (session) => params?.agent_id === undefined || session.agent?.id === params.agent_id,
        )
        .sort(byCreatedAtThenIdDescending)
      return Promise.resolve(pageByKey(all, params?.limit, params?.page, 'desc'))
    },

    async delete(sessionId, requestOptions): Promise<void> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const brain = await requireBrain(sessionId)
      // The 204 has no body: the effect is the deletion — one final `session.deleted` event
      // to the subscribers, the streams closed behind it, and the log dropped.
      brain.markDeleted()
    },

    events: eventsResource,
  }

  const providerCredentialsResource: Client['providerCredentials'] = {
    async list(requestOptions): Promise<ListProviderCredentialsResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const all = [...credentials.values()].sort(byCreatedAtThenId)
      return Promise.resolve({ data: all })
    },

    async put(provider, body, requestOptions): Promise<ProviderCredential> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      // The server validates a new key with one cheap provider call and answers 422 when the
      // provider refuses it; a key with no characters in it fails that call every time, which
      // is the one rejection a test can spell without a provider.
      if (body.api_key.trim() === '') {
        throw new ApiError(422, `The ${provider} credential was rejected by the provider.`, {
          type: 'invalid_provider_credential',
        })
      }
      const existing = credentials.get(provider)
      const timestamp = now().toISOString()
      const stored = ProviderCredentialSchema.parse({
        id: existing?.id ?? newProviderCredentialId(),
        type: body.type,
        provider,
        last4: body.api_key.slice(-4),
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
        validated_at: timestamp,
      })
      credentials.set(provider, stored)
      return stored
    },

    async delete(provider, requestOptions): Promise<void> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      // Idempotent, like the server's 204: deleting what is not there is not an error.
      credentials.delete(provider)
    },
  }

  const modelsResource: Client['models'] = {
    async list(params, requestOptions): Promise<ListModelsResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      modelListCalls.push({ refresh: params?.refresh === true })
      // The server answers sorted by provider, then name, and validates its own wire shape;
      // the fake does the same, so a catalog UI tested here meets what the server sends.
      return ListModelsResponseSchema.parse({
        data: [...models].sort(byProviderThenName),
        providers: [...providers],
      })
    },
  }

  const preferencesResource: Client['preferences'] = {
    get(requestOptions): Promise<GetPreferencesResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      return Promise.resolve(preferences)
    },

    put(next, requestOptions): Promise<GetPreferencesResponse> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      // Written whole, like the server's PUT — no partial update — and `null` clears the
      // stored default. Parsed with the protocol's schema, the way the route validates it.
      preferences = UserPreferencesSchema.parse(next)
      return Promise.resolve(preferences)
    },
  }

  const authResource: Client['auth'] = {
    startDeviceLogin(requestOptions): Promise<DeviceLoginStart> {
      throwIfAborted(requestOptions)
      const flow = ensureDeviceFlow()
      return Promise.resolve({
        deviceCode: flow.deviceCode,
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        verificationUriComplete: flow.verificationUriComplete,
        interval: flow.interval,
        expiresIn: flow.expiresIn,
      })
    },

    async pollDeviceLogin(deviceCode, pollOptions?: PollDeviceLoginOptions): Promise<string> {
      const flow = deviceFlow
      if (flow === undefined || deviceCode !== flow.deviceCode) {
        throw new DeviceLoginError('invalid_grant', 'There is no such device login.')
      }
      for (;;) {
        await sleep((pollOptions?.interval ?? flow.interval) * 1000, pollOptions?.signal)
        pollOptions?.signal?.throwIfAborted()
        flow.polls += 1
        if (flow.polls <= flow.pendingPolls) {
          continue
        }
        if (flow.outcome === 'denied') {
          throw new DeviceLoginError('access_denied', 'The user denied the login.')
        }
        if (flow.outcome === 'expired') {
          throw new DeviceLoginError('expired_token', 'The device code has expired.')
        }
        authenticated = true
        return FAKE_SESSION_TOKEN
      }
    },

    async signOut(requestOptions): Promise<void> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      authenticated = false
    },
  }

  const fake: FakeClient = {
    // The seeded agent and session are read back through the fake's own maps, not held by
    // reference (issue #106): an update through `agents.update` is visible here at once, and
    // so is every internal move of the session — its status, and its model after a message
    // switched it.
    get agent(): Agent {
      return agents.get(seedAgent.id) ?? seedAgent
    },
    get session(): Session {
      return brains.get(seedSession.id)?.session ?? seedSession
    },
    user,
    modelListCalls,
    agents: agentsResource,
    sessions: sessionsResource,
    providerCredentials: providerCredentialsResource,
    models: modelsResource,
    auth: authResource,
    preferences: preferencesResource,

    me(requestOptions): Promise<User> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      return Promise.resolve(user)
    },

    async sendMessage(sessionId, text, messageOptions): Promise<UserMessageEvent> {
      throwIfAborted(messageOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const brain = await requireBrain(sessionId)
      const stored = brain.appendUserEvent({
        type: 'user.message',
        content: [{ type: 'text', text }],
        ...(messageOptions?.model === undefined ? {} : { model: messageOptions.model }),
      })
      brain.startTurn()
      return stored as UserMessageEvent
    },

    async interrupt(sessionId, requestOptions): Promise<UserInterruptEvent> {
      throwIfAborted(requestOptions)
      if (!authenticated) {
        return unauthenticated()
      }
      const brain = await requireBrain(sessionId)
      const stored = brain.appendUserEvent({ type: 'user.interrupt' }) as UserInterruptEvent
      // The server starts a turn for an interrupt even when none is running — a queued
      // `user.interrupt` still has to be claimed, and the turn that ends on it does that (P4).
      brain.startTurn()
      return stored
    },

    respondWith(text, replyOptions = {}) {
      return scriptOn(replyOptions.sessionId ?? fake.session.id, {
        kind: 'reply',
        reply: { text, chunks: replyOptions.chunks, delayMs: replyOptions.delayMs },
      })
    },

    failWith(failureOptions = {}) {
      const type = failureOptions.type ?? 'model_overloaded_error'
      return scriptOn(failureOptions.sessionId ?? fake.session.id, {
        kind: 'failure',
        failure: {
          type,
          message: failureOptions.message ?? defaultErrorMessage(type),
          retryStatus: failureOptions.retryStatus ?? 'retrying',
          delayMs: failureOptions.delayMs,
        },
      })
    },

    scriptDeviceLogin(flowOptions = {}) {
      deviceFlow = makeDeviceFlow(flowOptions)
      return fake
    },

    waitForIdle(sessionId) {
      return brainFor(sessionId ?? fake.session.id).waitForIdle()
    },

    history(sessionId) {
      return brainFor(sessionId ?? fake.session.id).history()
    },
  }

  return fake
}

/** The fake's device flow: the script, and how far the polls have come. */
interface FakeDeviceFlow {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly interval: number
  readonly expiresIn: number
  readonly outcome: 'approved' | 'denied' | 'expired'
  readonly pendingPolls: number
  /** How many polls have happened; the first {@link pendingPolls} answer `authorization_pending`. */
  polls: number
}

/** Build a device flow from a script, filling in deterministic defaults. */
function makeDeviceFlow(options: FakeDeviceFlowOptions): FakeDeviceFlow {
  const userCode = options.userCode ?? 'FAKE-CODE'
  const verificationUri = options.verificationUri ?? 'http://localhost:3000/device'
  return {
    deviceCode: options.deviceCode ?? 'fake_device_code',
    userCode,
    verificationUri,
    verificationUriComplete:
      options.verificationUriComplete ?? `${verificationUri}?user_code=${userCode}`,
    interval: options.interval ?? 0,
    expiresIn: options.expiresIn ?? 600,
    outcome: options.outcome ?? 'approved',
    pendingPolls: options.pendingPolls ?? 1,
    polls: 0,
  }
}

/**
 * A live view of a session's stream, for as long as the caller keeps iterating.
 *
 * The backlog comes first, when the caller asked for one, and then whatever the brain emits —
 * which is why a test can start iterating and *then* send a message: the subscription is in
 * place before the message is, so nothing is missed.
 */
async function* streamFromBrain(
  brainFor: () => FakeBrain,
  options: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const brain = brainFor()
  if (options.signal?.aborted === true) {
    return
  }
  const subscriber = brain.subscribe(options)
  const abort = (): void => {
    subscriber.queue.close()
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  try {
    for (;;) {
      const event = await subscriber.queue.next()
      if (event === null) {
        return
      }
      yield event
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    brain.unsubscribe(subscriber)
  }
}

/** One user event or a list of them, without guessing from the contents of one. */
function isEventList(
  events: UserEventInput | readonly UserEventInput[],
): events is readonly UserEventInput[] {
  return Array.isArray(events)
}

/** Reject the way `fetch` does when the caller has already aborted. */
function throwIfAborted(options: RequestOptions | undefined): void {
  if (options?.signal?.aborted === true) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
}

/** The default message for a failure the caller did not describe. */
function defaultErrorMessage(type: SessionErrorType): string {
  return type === 'model_overloaded_error'
    ? 'The model is overloaded. Retrying.'
    : `The model request failed (${type}).`
}

/** The fields a keyset cursor is made of. */
interface Keyed {
  readonly created_at: string
  readonly id: string
}

/** Compare two items by `(created_at, id)`, the total order every list is in. */
function compareKeys(a: Keyed, b: Keyed): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** `(created_at, id)`, oldest first. */
function byCreatedAtThenId(a: Keyed, b: Keyed): number {
  return compareKeys(a, b)
}

/** `(created_at, id)`, newest first, the way sessions are listed. */
function byCreatedAtThenIdDescending(a: Keyed, b: Keyed): number {
  return compareKeys(b, a)
}

/** The model catalog's order: provider, then display name. */
function byProviderThenName(a: ModelEntry, b: ModelEntry): number {
  if (a.provider !== b.provider) {
    return a.provider < b.provider ? -1 : 1
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** One page of a `(created_at, id)`-ordered list, with the cursor to carry on from. */
function pageByKey<T extends Keyed>(
  items: readonly T[],
  limit: number | undefined,
  page: string | undefined,
  direction: 'asc' | 'desc',
): { data: T[]; next_page: string | null } {
  let start = 0
  if (page !== undefined) {
    const cursor = tryDecodePageCursor(page)
    if (cursor?.kind === 'key') {
      // The next page starts at the first item strictly after (ascending) or before
      // (descending) the position the cursor carries. Decoding it here is the fake playing
      // the server: the client itself never looks inside a cursor.
      const found = items.findIndex((item) =>
        direction === 'asc' ? compareKeys(item, cursor) > 0 : compareKeys(item, cursor) < 0,
      )
      start = found === -1 ? items.length : found
    }
  }
  const data = items.slice(start, start + clampLimit(limit))
  const last = data.at(-1)
  const more = last !== undefined && items.length > start + data.length
  return { data, next_page: more ? encodeKeyCursor(last) : null }
}
