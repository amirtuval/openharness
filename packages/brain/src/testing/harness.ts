import type {
  AgentMessageEvent,
  ModelRequestEndEvent,
  ModelRequestStartEvent,
  ReasoningEffort,
  SessionId,
  StoredEvent,
  StoredEventDelta,
  StoredEventStart,
  UserEventInput,
} from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'
import type { Clock } from '@openharness/session'
import { createTestClock } from '@openharness/session/testing'
import type { TestClock } from '@openharness/session/testing'

/**
 * The session every turn test runs against: an in-memory store on a clock a test can move,
 * and one agent whose model is the model id the fixtures use.
 *
 * The brain talks to the store through the merged `SessionStore` contract and nothing else, so
 * this is the whole fixture: no database, no HTTP, no server.
 */

/** The model id sessions run, spelled the way the protocol's `ModelConfig` is. */
export const TEST_MODEL_ID = 'anthropic/claude-sonnet-5'

/**
 * The owner the fixture creates its agent and session as (epic #65, A4).
 *
 * The brain never looks at ownership — it acts for a session — so any valid user id does; the
 * real one is Better Auth's, wired by the server (#61). Exported so a test that creates its
 * own resources against this store's partition space names the same owner.
 */
export const TEST_OWNER_ID = 'user_brain_tests'

/** The system prompt the test agent is created with. */
export const TEST_SYSTEM = 'You are a concise technical assistant.'

/** A session to run turns against, and the things a test needs to inspect it. */
export interface TestSession {
  /** The store the turn is handed. */
  readonly store: InMemorySessionStore
  /** The session to run. */
  readonly sessionId: SessionId
  /** The store's clock, for advancing time. */
  readonly clock: TestClock
}

/** What {@link newSession} lets a test override. */
export interface NewSessionOptions {
  /** The agent's system prompt; the fixture's default when omitted, `null` for none. */
  readonly system?: string | null
  /** The clock the store runs on; a fresh test clock when omitted. */
  readonly clock?: TestClock
  /**
   * Build the session's store on the clock given, instead of the plain in-memory one — for a
   * test that needs a store which refuses, records or paces something the turn appends.
   */
  readonly makeStore?: (now: Clock) => InMemorySessionStore
}

/**
 * Create a session with an agent, and optionally some events already in its log.
 *
 * @param initialEvents the events the session starts with, as a client would send them
 * @param options overrides: the agent's system prompt, the store's clock, and the store
 *   itself — a test that needs one which refuses or records an append builds a subclass and
 *   passes it through {@link NewSessionOptions.makeStore}
 */
export async function newSession(
  initialEvents: UserEventInput[] = [],
  options: NewSessionOptions = {},
): Promise<TestSession> {
  const clock = options.clock ?? createTestClock()
  const store = options.makeStore?.(clock.now) ?? new InMemorySessionStore({ now: clock.now })
  // Every agent and session belongs to one user (epic #65, A4). The brain never looks at
  // ownership — it acts for a session — so the fixture's owner is just a valid id; the real
  // one comes from Better Auth once the server wires it (#61).
  const agent = await store.createAgent(
    {
      name: 'Summarizer',
      model: { id: TEST_MODEL_ID },
      system: options.system === undefined ? TEST_SYSTEM : options.system,
    },
    TEST_OWNER_ID,
  )
  const session = await store.createSession(agent.id, {
    ownerId: TEST_OWNER_ID,
    initial_events: initialEvents,
  })
  return { store, sessionId: session.id, clock }
}

/**
 * A message event as a client sends it.
 *
 * @param text the message body
 * @param reasoningEffort the effort this message asks for (#252); omitted leaves the session's
 *   effort alone, and `null` asks for the provider's default again
 */
export function message(text: string, reasoningEffort?: ReasoningEffort | null): UserEventInput {
  return {
    type: 'user.message',
    content: [{ type: 'text', text }],
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  }
}

/** An interrupt event as a client sends it. */
export function interrupt(): UserEventInput {
  return { type: 'user.interrupt' }
}

/**
 * The session's whole log, oldest first, as a **reader** sees it: the replay read, which skips
 * superseded chunks.
 *
 * This is what a client resumes from, so it is what most assertions want — a test that asks
 * whether replay holds a superseded chunk asks this and sees none.
 */
export async function logOf(
  store: InMemorySessionStore,
  sessionId: SessionId,
): Promise<StoredEvent[]> {
  return await readLogWith(store, sessionId, {})
}

/**
 * The raw log, oldest first: superseded chunks included.
 *
 * What the store physically holds, which is what a test needs to assert that a chunk was
 * written at all, or that compaction deleted it. See `listEvents`' `includeSuperseded`.
 */
export async function rawLogOf(
  store: InMemorySessionStore,
  sessionId: SessionId,
): Promise<StoredEvent[]> {
  return await readLogWith(store, sessionId, { includeSuperseded: true })
}

/** Page through a session's log with the given list options. */
async function readLogWith(
  store: InMemorySessionStore,
  sessionId: SessionId,
  options: { readonly includeSuperseded?: boolean },
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = []
  let afterSeq = 0
  for (;;) {
    const page = await store.listEventsUnscoped(sessionId, {
      order: 'asc',
      afterSeq,
      limit: 100,
      ...options,
    })
    events.push(...page.data)
    const last = page.data[page.data.length - 1]
    if (page.next_page === null || last === undefined) {
      return events
    }
    afterSeq = last.seq
  }
}

/**
 * The log as a list of readable labels, for asserting the exact order a turn wrote.
 *
 * Spans, messages and statuses read as their type; the tests that care about the fields inside
 * an event assert on the event itself.
 */
export function eventTypes(events: readonly StoredEvent[]): string[] {
  return events.map((event) => event.type)
}

/** The text one message event carries. */
export function textOf(event: StoredEvent | undefined): string {
  if (event === undefined || (event.type !== 'user.message' && event.type !== 'agent.message')) {
    throw new Error(`expected a message event, got ${event?.type ?? 'nothing'}`)
  }
  return event.content.map((block) => block.text).join('')
}

/**
 * A stored event a test knows is a `span.model_request_start`.
 *
 * A test that builds a log by hand appends a start before it can point at it — the store
 * assigns the id — so this is how it gets the stored event back, typed.
 *
 * @param event a stored event, or nothing
 */
export function spanStartOf(event: StoredEvent | undefined): ModelRequestStartEvent {
  if (event?.type !== 'span.model_request_start') {
    throw new Error(`expected a stored span.model_request_start, got ${event?.type ?? 'nothing'}`)
  }
  return event
}

/** A stored event a test knows is a `span.model_request_end`. */
export function spanEndOf(event: StoredEvent | undefined): ModelRequestEndEvent {
  if (event?.type !== 'span.model_request_end') {
    throw new Error(`expected a stored span.model_request_end, got ${event?.type ?? 'nothing'}`)
  }
  return event
}

/** A stored event a test knows is a stored `event_start` chunk. */
export function chunkStartOf(event: StoredEvent | undefined): StoredEventStart {
  if (event?.type !== 'event_start') {
    throw new Error(`expected a stored event_start, got ${event?.type ?? 'nothing'}`)
  }
  return event
}

/** A stored event a test knows is a stored `event_delta` chunk. */
export function chunkDeltaOf(event: StoredEvent | undefined): StoredEventDelta {
  if (event?.type !== 'event_delta') {
    throw new Error(`expected a stored event_delta, got ${event?.type ?? 'nothing'}`)
  }
  return event
}

/** A stored event a test knows is an `agent.message`. */
export function agentMessageOf(event: StoredEvent | undefined): AgentMessageEvent {
  if (event?.type !== 'agent.message') {
    throw new Error(`expected a stored agent.message, got ${event?.type ?? 'nothing'}`)
  }
  return event
}

/** Every stored chunk of a log, in order — `event_start` and `event_delta` events. */
export function chunksOf(events: readonly StoredEvent[]): StoredEvent[] {
  return events.filter((event) => event.type === 'event_start' || event.type === 'event_delta')
}

/** The text a stored `event_delta` carries. */
export function deltaTextOf(event: StoredEventDelta): string {
  return event.delta.content.text
}

/** Let every queued microtask (a store's delivery, a listener) run before asserting. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
