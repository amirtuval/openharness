import type { EventId } from '../ids'
import { newAgentId, newEventId, newModeId, newProviderCredentialId, newSessionId } from '../ids'
import { SUMMARY_MODEL_SAME_AS_CHAT } from '../index'
import type {
  Agent,
  AgentMessageEvent,
  ContentDelta,
  ContextSummaryEvent,
  ContextSummaryProgressEvent,
  ListModelsResponse,
  Mode,
  ModelEntry,
  ModelRequestEndEvent,
  ModelRequestStartEvent,
  ModelUsage,
  ProviderCatalogStatus,
  ProviderCredential,
  ProviderCredentialMetadata,
  Session,
  SessionAgent,
  SessionCompactEvent,
  SessionCompactionEvent,
  SessionDeletedEvent,
  SessionError,
  SessionErrorEvent,
  SessionModelUsage,
  SessionRewindEvent,
  SessionStatusIdleEvent,
  SessionStatusRescheduledEvent,
  SessionStatusRunningEvent,
  SessionUsageEvent,
  StoredEvent,
  StoredEventDelta,
  StoredEventStart,
  User,
  UserInterruptEvent,
  UserMessageEvent,
  UserPreferences,
  GetPreferencesResponse,
  PreferencesDefaults,
} from '../index'

/**
 * Subpath export `@openharness/protocol/fixtures`.
 *
 * Builders for every resource and event in the protocol, plus a realistic sample session.
 * `@openharness/session`, `@openharness/brain`, the server and the client tests all need
 * well-formed protocol objects, and hand-rolling them invites drift from the schemas — the
 * builders here are the single place that knows how to make one.
 *
 * The event builders hand out ids from {@link newEventId} and a shared running `seq`. Pass
 * `seq` (or `id`) in the overrides when a test needs a specific one; the sample history below
 * pins both so it reads as a fixed story.
 *
 * These are plain builders: they construct typed values and leave validation to the caller,
 * so a test can assert that what the fixtures produce actually parses against the schemas.
 */

/** Running `seq` handed to events built without an explicit one. One per session, as on the wire. */
let nextSeq = 1

/** Allocate the next fixture `seq`. */
function takeSeq(): number {
  return nextSeq++
}

/** A fixed instant, the anchor for every timestamp in the sample session. */
const SAMPLE_EPOCH = Date.UTC(2026, 2, 15, 10, 0, 0)

/**
 * A timestamp `offsetSeconds` after {@link SAMPLE_EPOCH}, in RFC 3339 form.
 *
 * @param offsetSeconds seconds past the anchor; may be fractional
 */
export function fixtureTimestamp(offsetSeconds = 0): string {
  return new Date(SAMPLE_EPOCH + offsetSeconds * 1000).toISOString()
}

/**
 * An `agent` resource.
 *
 * @param overrides fields to replace on the default agent
 */
export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const agent: Agent = {
    id: newAgentId(),
    type: 'agent',
    owner_id: makeUser().id,
    name: 'Summarizer',
    description: 'Summarizes a repository for a chat user.',
    model: { id: 'anthropic/claude-sonnet-5' },
    system: 'You are a concise technical assistant.',
    created_at: fixtureTimestamp(),
    updated_at: fixtureTimestamp(),
  }
  return { ...agent, ...overrides }
}

/**
 * The agent snapshot a session is created with.
 *
 * @param overrides fields to replace on the default snapshot
 */
export function makeSessionAgent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  const agent: SessionAgent = {
    id: newAgentId(),
    name: 'Summarizer',
    model: { id: 'anthropic/claude-sonnet-5' },
    system: 'You are a concise technical assistant.',
  }
  return { ...agent, ...overrides }
}

/**
 * A `session` resource, `idle` with no title and no metadata unless overridden.
 *
 * @param overrides fields to replace on the default session
 */
export function makeSession(overrides: Partial<Session> = {}): Session {
  const session: Session = {
    id: newSessionId(),
    type: 'session',
    owner_id: makeUser().id,
    status: 'idle',
    title: null,
    metadata: {},
    model: { id: 'anthropic/claude-sonnet-5' },
    system: 'You are a concise technical assistant.',
    mode: null,
    agent: makeSessionAgent(),
    created_at: fixtureTimestamp(),
    updated_at: fixtureTimestamp(),
  }
  return { ...session, ...overrides }
}

/**
 * A signed-in `user`, as `GET /v1/me` returns them.
 *
 * The id is a fixed opaque string, the shape Better Auth mints — not a `usr_`-prefixed ULID,
 * because user ids are not this package's to format. `image` is left absent, the common case;
 * pass it in the overrides when a test needs one.
 *
 * @param overrides fields to replace on the default user
 */
export function makeUser(overrides: Partial<User> = {}): User {
  const user: User = {
    id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    created_at: fixtureTimestamp(),
  }
  return { ...user, ...overrides }
}

/**
 * A user's stored preferences, as the store holds them: a default model, the default theme and
 * the compaction controls unset (each `null` meaning "follow the default"), unless the overrides
 * replace any of them.
 *
 * @param overrides fields to replace on the default preferences
 */
export function makeUserPreferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  const preferences: UserPreferences = {
    default_model: 'anthropic/claude-sonnet-5',
    theme: 'system',
    compaction_threshold: null,
    summary_model: SUMMARY_MODEL_SAME_AS_CHAT,
    summary_max_passes: null,
  }
  return { ...preferences, ...overrides }
}

/**
 * The defaults a preference of `null` falls back to, as `GET /v1/me/preferences` reports them
 * (epic #277, C3; #282): the engine's own share and pass limit.
 *
 * @param overrides fields to replace on the default values
 */
export function makePreferencesDefaults(
  overrides: Partial<PreferencesDefaults> = {},
): PreferencesDefaults {
  const defaults: PreferencesDefaults = {
    // The engine's own defaults, `0.7` and `3` — written as literals because they are the
    // brain's and the server's to choose, not this package's (see `PreferencesDefaultsSchema`).
    compaction_threshold: 0.7,
    summary_max_passes: 3,
  }
  return { ...defaults, ...overrides }
}

/**
 * A preferences response, as `GET`/`PUT /v1/me/preferences` answers: {@link makeUserPreferences}
 * plus the defaults its `null`s mean.
 *
 * @param overrides fields to replace on the default preferences
 * @param defaults fields to replace on the default values
 */
export function makeGetPreferencesResponse(
  overrides: Partial<UserPreferences> = {},
  defaults: Partial<PreferencesDefaults> = {},
): GetPreferencesResponse {
  return { ...makeUserPreferences(overrides), defaults: makePreferencesDefaults(defaults) }
}

/**
 * A provider credential's metadata, as the API returns it: an `anthropic` `api_key` whose
 * secret ends in `cdef`, validated when it was saved. Never carries the secret itself.
 *
 * @param overrides fields to replace on the default credential
 */
export function makeProviderCredential(
  overrides: Partial<ProviderCredentialMetadata> = {},
): ProviderCredential {
  const credential: ProviderCredentialMetadata = {
    id: newProviderCredentialId(),
    type: 'api_key',
    name: 'anthropic',
    last4: 'cdef',
    created_at: fixtureTimestamp(),
    updated_at: fixtureTimestamp(),
    validated_at: fixtureTimestamp(),
  }
  // `ProviderCredential` is a discriminated union, and the fixture's caller decides which
  // variant it means: a `type` and its own `details` are consistent by construction, so the
  // wide `ProviderCredentialMetadata` the spread builds is the union the caller asked for.
  return { ...credential, ...overrides } as ProviderCredential
}

/**
 * A mode (#245, M6): a `deep` preset on `anthropic/claude-sonnet-5` at a `high` effort, with
 * a one-line system-prompt addition.
 *
 * @param overrides fields to replace on the default mode
 */
export function makeMode(overrides: Partial<Mode> = {}): Mode {
  const mode: Mode = {
    id: newModeId(),
    type: 'mode',
    owner_id: makeUser().id,
    name: 'deep',
    model: 'anthropic/claude-sonnet-5',
    reasoning_effort: 'high',
    system_prompt_addition: 'Think step by step before answering.',
    created_at: fixtureTimestamp(),
    updated_at: fixtureTimestamp(),
  }
  return { ...mode, ...overrides }
}

/**
 * A model-catalog entry: `anthropic/claude-sonnet-5` as the provider's own list reports it,
 * `source: 'provider'`.
 *
 * @param overrides fields to replace on the default entry
 */
export function makeModelEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  const entry: ModelEntry = {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    context_window: 200_000,
    max_output_tokens: 64_000,
    // The real rates for this id, so a test that prices bytes with them asserts something
    // true of the model the entry names (#247). Pass `cost: null` for an unpriced model.
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    source: 'provider',
  }
  return { ...entry, ...overrides }
}

/**
 * A `GET /v1/models` response: one model entry and the `ok` status of the provider it names.
 *
 * @param overrides fields to replace on the default response
 */
export function makeListModelsResponse(
  overrides: Partial<ListModelsResponse> = {},
): ListModelsResponse {
  const entry = makeModelEntry()
  const status: ProviderCatalogStatus = {
    provider: entry.provider,
    status: 'ok',
    fetched_at: fixtureTimestamp(),
    message: null,
  }
  const response: ListModelsResponse = { data: [entry], providers: [status] }
  return { ...response, ...overrides }
}

// ---------------------------------------------------------------- user events

/**
 * A stored `user.message`.
 *
 * @param text the message body; becomes the single text block
 * @param overrides fields to replace on the event
 */
export function makeUserMessage(
  text: string,
  overrides: Partial<UserMessageEvent> = {},
): UserMessageEvent {
  const event: UserMessageEvent = {
    id: newEventId(),
    type: 'user.message',
    seq: takeSeq(),
    processed_at: null,
    content: [{ type: 'text', text }],
  }
  return { ...event, ...overrides }
}

/**
 * A stored `user.interrupt`.
 *
 * @param overrides fields to replace on the event
 */
export function makeUserInterrupt(overrides: Partial<UserInterruptEvent> = {}): UserInterruptEvent {
  const event: UserInterruptEvent = {
    id: newEventId(),
    type: 'user.interrupt',
    seq: takeSeq(),
    processed_at: null,
  }
  return { ...event, ...overrides }
}

// --------------------------------------------------------------- agent events

/**
 * A stored `agent.message`.
 *
 * @param text the reply body; becomes the single text block
 * @param overrides fields to replace on the event
 */
export function makeAgentMessage(
  text: string,
  overrides: Partial<AgentMessageEvent> = {},
): AgentMessageEvent {
  const event: AgentMessageEvent = {
    id: newEventId(),
    type: 'agent.message',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    content: [{ type: 'text', text }],
  }
  return { ...event, ...overrides }
}

// ------------------------------------------------------------- session events

/**
 * A `session.status_running` event.
 *
 * @param overrides fields to replace on the event
 */
export function makeStatusRunning(
  overrides: Partial<SessionStatusRunningEvent> = {},
): SessionStatusRunningEvent {
  const event: SessionStatusRunningEvent = {
    id: newEventId(),
    type: 'session.status_running',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
  }
  return { ...event, ...overrides }
}

/**
 * A `session.status_idle` event, `end_turn` unless overridden.
 *
 * @param overrides fields to replace on the event
 */
export function makeStatusIdle(
  overrides: Partial<SessionStatusIdleEvent> = {},
): SessionStatusIdleEvent {
  const event: SessionStatusIdleEvent = {
    id: newEventId(),
    type: 'session.status_idle',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    stop_reason: { type: 'end_turn' },
  }
  return { ...event, ...overrides }
}

/**
 * A `session.status_rescheduled` event.
 *
 * @param overrides fields to replace on the event
 */
export function makeStatusRescheduled(
  overrides: Partial<SessionStatusRescheduledEvent> = {},
): SessionStatusRescheduledEvent {
  const event: SessionStatusRescheduledEvent = {
    id: newEventId(),
    type: 'session.status_rescheduled',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
  }
  return { ...event, ...overrides }
}

/**
 * A `session.rewind` event (#238): the session restarts from an earlier `user.message`.
 *
 * The default range covers `1..2`, the shape a session that has said one thing and been
 * answered once produces — override `supersedes` (and usually `seq`) for anything else.
 *
 * @param overrides fields to replace on the event
 */
export function makeSessionRewind(overrides: Partial<SessionRewindEvent> = {}): SessionRewindEvent {
  const event: SessionRewindEvent = {
    id: newEventId(),
    type: 'session.rewind',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    supersedes: { from_seq: 1, to_seq: 2 },
  }
  return { ...event, ...overrides }
}

/**
 * A `session.deleted` stream event (#111): the last event a stream for a deleted session
 * delivers. Not a stored event — it carries no `seq` and never lands in a log.
 *
 * @param overrides fields to replace on the event
 */
export function makeSessionDeleted(
  overrides: Partial<SessionDeletedEvent> = {},
): SessionDeletedEvent {
  const event: SessionDeletedEvent = {
    type: 'session.deleted',
    session_id: newSessionId(),
  }
  return { ...event, ...overrides }
}

/**
 * A `session.error` event. Defaults to a retryable `model_overloaded_error`.
 *
 * @param overrides fields to replace on the event
 * @param overrides.error the `error` object, when the default one will not do
 */
export function makeSessionError(overrides: Partial<SessionErrorEvent> = {}): SessionErrorEvent {
  const error: SessionError = {
    type: 'model_overloaded_error',
    message: 'The model is overloaded. Retrying.',
    retry_status: { type: 'retrying' },
  }
  const event: SessionErrorEvent = {
    id: newEventId(),
    type: 'session.error',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    error,
  }
  return { ...event, ...overrides }
}

// ---------------------------------------------------------------- span events

/**
 * A `span.model_request_start` event.
 *
 * @param overrides fields to replace on the event
 */
export function makeModelRequestStart(
  overrides: Partial<ModelRequestStartEvent> = {},
): ModelRequestStartEvent {
  const event: ModelRequestStartEvent = {
    id: newEventId(),
    type: 'span.model_request_start',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
  }
  return { ...event, ...overrides }
}

/** Token usage a fixture model request reports. Override it per test. */
export const FIXTURE_MODEL_USAGE: ModelUsage = {
  input_tokens: 512,
  output_tokens: 64,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/**
 * A `span.model_request_end` event that closes `start`, with no error by default.
 *
 * @param start the `span.model_request_start` this closes
 * @param overrides fields to replace on the event
 */
export function makeModelRequestEnd(
  start: ModelRequestStartEvent,
  overrides: Partial<ModelRequestEndEvent> = {},
): ModelRequestEndEvent {
  const event: ModelRequestEndEvent = {
    id: newEventId(),
    type: 'span.model_request_end',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    model_request_start_id: start.id,
    model_usage: { ...FIXTURE_MODEL_USAGE },
    is_error: null,
  }
  return { ...event, ...overrides }
}

// ------------------------------------------------------- session usage (#247)

/**
 * A stored `session.usage`: the session's running totals, one entry per model it has run.
 *
 * The counters beside the breakdown are **derived from it**, so the fixture always satisfies the
 * schema's own rule that the two agree — a test that wants the totals to differ from the sum of
 * the models has to build the event by hand, which is exactly the case the schema refuses.
 *
 * @param models one entry per model, its running totals for the session
 * @param overrides fields to replace on the event
 */
export function makeSessionUsage(
  models: readonly SessionModelUsage[] = [
    { model: 'anthropic/claude-sonnet-5', usage: { ...FIXTURE_MODEL_USAGE }, requests: 1 },
  ],
  overrides: Partial<Omit<SessionUsageEvent, 'models'>> = {},
): SessionUsageEvent {
  const sum = (pick: (usage: ModelUsage) => number): number =>
    models.reduce((total, entry) => total + pick(entry.usage), 0)
  const event: SessionUsageEvent = {
    id: newEventId(),
    type: 'session.usage',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    input_tokens: sum((usage) => usage.input_tokens),
    output_tokens: sum((usage) => usage.output_tokens),
    cache_creation_input_tokens: sum((usage) => usage.cache_creation_input_tokens),
    cache_read_input_tokens: sum((usage) => usage.cache_read_input_tokens),
    models: models.map((entry) => ({
      model: entry.model,
      usage: { ...entry.usage },
      requests: entry.requests,
    })),
  }
  return { ...event, ...overrides }
}

// --------------------------------------------------- context summary (epic #277)

/**
 * A stored `session.context_summary`: older history replaced for the model by a summary.
 *
 * The default covers `1..8` — a conversation whose first four turns were summarized — and names
 * the chat's own model as the summary model, `threshold` as the reason and one pass. Override
 * anything a test cares about; the schema is what rejects a shape the protocol would not store.
 *
 * @param overrides fields to replace on the event
 */
export function makeContextSummary(
  overrides: Partial<ContextSummaryEvent> = {},
): ContextSummaryEvent {
  const event: ContextSummaryEvent = {
    id: newEventId(),
    type: 'session.context_summary',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    summary: 'The user asked for a README summary; the answer is that it is Managed Agents.',
    covers: { to_seq: 8 },
    reason: 'threshold',
    tokens_before: 51_200,
    summary_model: 'anthropic/claude-sonnet-5',
    prompt_version: 'compact-v1',
    passes: 1,
  }
  return { ...event, ...overrides }
}

/**
 * A stored `session.context_summary_progress`: the compaction engine's next pass (#279).
 *
 * The default is the second of three passes — the middle of a chunked summary, which is the
 * shape a client's progress bar exists for. Override `pass`/`passes` for a one-pass run or the
 * last pass; the schema refuses zero or a negative on either.
 *
 * @param overrides fields to replace on the event
 */
export function makeContextSummaryProgress(
  overrides: Partial<ContextSummaryProgressEvent> = {},
): ContextSummaryProgressEvent {
  const event: ContextSummaryProgressEvent = {
    id: newEventId(),
    type: 'session.context_summary_progress',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    pass: 2,
    passes: 3,
  }
  return { ...event, ...overrides }
}

/**
 * A stored `session.compact`: the user's `/compact [instructions]` request (epic #277, K8; #283).
 *
 * The default carries guidance, which is the interesting shape — a plain `/compact` is the same
 * builder with `instructions: undefined`. The stored request is followed, in a real log, by the
 * `session.compaction` that answers it ({@link makeSessionCompaction}).
 *
 * @param overrides fields to replace on the event
 */
export function makeSessionCompact(
  overrides: Partial<SessionCompactEvent> = {},
): SessionCompactEvent {
  const event: SessionCompactEvent = {
    id: newEventId(),
    type: 'session.compact',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    instructions: 'keep the API decisions in detail',
  }
  return { ...event, ...overrides }
}

/**
 * A stored `session.compaction`: the brain's answer to a manual request (epic #277, K8; #283).
 *
 * The default is a successful, guidance-carrying summary — the middle outcome a client shows a
 * divider for. Override `outcome` for `nothing_to_summarize` (with a `message`) or `failed`.
 *
 * @param overrides fields to replace on the event
 */
export function makeSessionCompaction(
  overrides: Partial<SessionCompactionEvent> = {},
): SessionCompactionEvent {
  const event: SessionCompactionEvent = {
    id: newEventId(),
    type: 'session.compaction',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    outcome: 'summarized',
    instructions: 'keep the API decisions in detail',
    summary_seq: 8,
  }
  return { ...event, ...overrides }
}

// ---------------------------------------------------------- stored chunks (D9)

/**
 * A `content_delta` payload.
 *
 * @param text the fragment of text to carry
 * @param overrides fields to replace on the delta
 */
export function makeContentDelta(
  text: string,
  overrides: Partial<ContentDelta> = {},
): ContentDelta {
  const delta: ContentDelta = {
    type: 'content_delta',
    index: 0,
    content: { type: 'text', text },
  }
  return { ...delta, ...overrides }
}

/**
 * A stored `event_start`: the chunk that opens the range an `agent.message` will supersede.
 *
 * Its own `id` — the one the store assigns this event — is fresh; `event.id` is the id of the
 * `agent.message` being previewed, which is what the deltas and the stored message carry too
 * (pass the same `previewedId` to all three to build one consistent reply).
 *
 * @param previewedId the `sevt_` id of the event being previewed
 * @param overrides fields to replace on the event
 */
export function makeStoredEventStart(
  previewedId: EventId,
  overrides: Partial<StoredEventStart> = {},
): StoredEventStart {
  const event: StoredEventStart = {
    id: newEventId(),
    type: 'event_start',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    event: { type: 'agent.message', id: previewedId },
  }
  return { ...event, ...overrides }
}

/**
 * A stored `event_delta`: one streamed fragment of the reply `eventId` is being written under.
 *
 * @param eventId the `sevt_` id of the event being previewed
 * @param text the fragment of text to carry
 * @param overrides fields to replace on the event
 */
export function makeStoredEventDelta(
  eventId: EventId,
  text: string,
  overrides: Partial<StoredEventDelta> = {},
): StoredEventDelta {
  const event: StoredEventDelta = {
    id: newEventId(),
    type: 'event_delta',
    seq: takeSeq(),
    processed_at: fixtureTimestamp(),
    event_id: eventId,
    delta: makeContentDelta(text),
  }
  return { ...event, ...overrides }
}

// -------------------------------------------------------------------- samples

/** A sample agent: an `anthropic/claude-sonnet-5` summarizer. */
export const sampleAgent: Agent = makeAgent({
  id: newAgentId(1770000000000),
  created_at: fixtureTimestamp(),
  updated_at: fixtureTimestamp(),
})

/** A sample mode: a `deep` preset on `anthropic/claude-sonnet-5` at a `high` effort. */
export const sampleMode: Mode = makeMode({
  id: newModeId(1770000000000),
  created_at: fixtureTimestamp(),
  updated_at: fixtureTimestamp(),
})

/** A session running {@link sampleAgent}, idle and titled. */
export const sampleSession: Session = makeSession({
  id: newSessionId(1770000000000),
  title: 'README summary',
  metadata: { source: 'fixtures' },
  agent: makeSessionAgent({
    id: sampleAgent.id,
    name: sampleAgent.name,
    model: sampleAgent.model,
    system: sampleAgent.system,
  }),
  created_at: fixtureTimestamp(),
  updated_at: fixtureTimestamp(12),
})

/**
 * A session history that exercises every part of the v1 lifecycle:
 *
 * 1. a full turn — `status_running`, `user.message`, a model request, `agent.message`,
 *    `status_idle { end_turn }`
 * 2. a steering message — the user speaks again while the turn is running, and the brain
 *    picks it up in the same turn
 * 3. an interrupt — `user.interrupt` cuts the model off mid-response, the partial text is
 *    still stored as an `agent.message`, and the span closes with an `interrupted` error
 * 4. a retried error — a `session.error` with `retry_status: retrying` and a
 *    `session.status_rescheduled`, then a fresh `session.status_running` and a clean reply
 *
 * It ends mid-turn: a last `user.message` sits at `processed_at: null`, the state a client
 * sees between sending a message and the brain reaching it. `seq` starts at 1 and increases
 * by one per event, the way the store assigns it.
 *
 * Every user event is claimed the way the brain claims one since P4: the `user.message` a
 * request answers is listed in that request's `span.model_request_start.consumes`, and the
 * interrupt that cut turn 3 short is listed in the `span.model_request_end.consumes` that
 * closed the request it stopped. The last message carries no claim, which is what leaves it
 * pending.
 */
export const sampleSessionHistory: StoredEvent[] = buildSampleSessionHistory()

function buildSampleSessionHistory(): StoredEvent[] {
  const events: StoredEvent[] = []
  const push = (event: StoredEvent): void => {
    events.push(event)
  }
  const at = (seq: number): { seq: number; processed_at: string } => ({
    seq,
    processed_at: fixtureTimestamp(seq),
  })

  // Turn 1: a complete turn, start to finish.
  const running1 = makeStatusRunning({ ...at(1) })
  push(running1)
  const message2 = makeUserMessage('Summarize the repo README in one sentence.', {
    ...at(2),
    processed_at: fixtureTimestamp(2),
  })
  push(message2)
  const start1 = makeModelRequestStart({ ...at(3), consumes: [message2.id] })
  push(start1)
  push(
    makeAgentMessage('openharness is an open-source implementation of Managed Agents.', {
      ...at(4),
    }),
  )
  push(
    makeModelRequestEnd(start1, {
      ...at(5),
      model_usage: { ...FIXTURE_MODEL_USAGE, input_tokens: 640, output_tokens: 24 },
    }),
  )
  push(makeStatusIdle({ ...at(6) }))

  // Turn 2: the user steers mid-turn; the queued message is picked up by the running turn.
  push(makeStatusRunning({ ...at(7) }))
  const message8 = makeUserMessage('Actually, mention the session log.', {
    ...at(8),
    processed_at: fixtureTimestamp(8),
  })
  push(message8)
  const start2 = makeModelRequestStart({ ...at(9), consumes: [message8.id] })
  push(start2)
  push(
    makeAgentMessage(
      'openharness is Managed Agents in the open: a durable session log, a stateless brain.',
      {
        ...at(10),
      },
    ),
  )
  push(
    makeModelRequestEnd(start2, {
      ...at(11),
      model_usage: { ...FIXTURE_MODEL_USAGE, input_tokens: 704, output_tokens: 31 },
    }),
  )
  push(makeStatusIdle({ ...at(12) }))

  // Turn 3: the user interrupts; the partial reply is kept and the span closes with an error.
  push(makeStatusRunning({ ...at(13) }))
  const message14 = makeUserMessage('Now write a haiku about it.', {
    ...at(14),
    processed_at: fixtureTimestamp(14),
  })
  push(message14)
  const start3 = makeModelRequestStart({ ...at(15), consumes: [message14.id] })
  push(start3)
  const interrupt16 = makeUserInterrupt({ ...at(16) })
  push(interrupt16)
  push(makeAgentMessage('Events in a log,', { ...at(17) }))
  push(
    makeModelRequestEnd(start3, {
      ...at(18),
      model_usage: { ...FIXTURE_MODEL_USAGE, input_tokens: 720, output_tokens: 6 },
      is_error: true,
      error: { type: 'interrupted', message: 'Interrupted by the user.' },
      consumes: [interrupt16.id],
    }),
  )
  push(makeStatusIdle({ ...at(19) }))

  // Turn 4: the model request fails, the session retries, and the retry succeeds.
  push(makeStatusRunning({ ...at(20) }))
  const message21 = makeUserMessage('And the license?', {
    ...at(21),
    processed_at: fixtureTimestamp(21),
  })
  push(message21)
  const failedStart = makeModelRequestStart({ ...at(22), consumes: [message21.id] })
  push(failedStart)
  push(
    makeModelRequestEnd(failedStart, {
      ...at(23),
      model_usage: { ...FIXTURE_MODEL_USAGE, input_tokens: 0, output_tokens: 0 },
      is_error: true,
      error: { type: 'model_error', message: 'The model is overloaded.' },
    }),
  )
  push(makeSessionError({ ...at(24) }))
  push(makeStatusRescheduled({ ...at(25) }))
  push(makeStatusRunning({ ...at(26) }))
  // The retry answers the same message: it is already claimed, so the fresh span claims nothing.
  const retryStart = makeModelRequestStart({ ...at(27), consumes: [] })
  push(retryStart)
  push(makeAgentMessage('MIT.', { ...at(28) }))
  push(
    makeModelRequestEnd(retryStart, {
      ...at(29),
      model_usage: { ...FIXTURE_MODEL_USAGE, input_tokens: 768, output_tokens: 2 },
    }),
  )
  push(makeStatusIdle({ ...at(30) }))

  // Turn 5: the user has just spoken; the brain has not picked the message up yet.
  push(makeStatusRunning({ ...at(31) }))
  push(makeUserMessage('One more thing: who maintains it?', { ...at(32), processed_at: null }))

  return events
}
