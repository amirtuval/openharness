import type {
  ModelRequestStartEvent,
  SessionId,
  StoredEvent,
  UserEventInput,
} from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'
import { createTestClock } from '@openharness/session/testing'
import type { TestClock } from '@openharness/session/testing'

/**
 * The session every turn test runs against: an in-memory store on a clock a test can move,
 * and one agent whose model is the router string the fixtures use.
 *
 * The brain talks to the store through the merged `SessionStore` contract and nothing else, so
 * this is the whole fixture: no database, no HTTP, no server.
 */

/** The model id sessions run, spelled the way the protocol's `ModelConfig` is. */
export const TEST_MODEL_ID = 'anthropic/claude-sonnet-5'

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

/**
 * Create a session with an agent, and optionally some events already in its log.
 *
 * @param initialEvents the events the session starts with, as a client would send them
 * @param options overrides: the agent's system prompt, and the store's clock
 */
export async function newSession(
  initialEvents: UserEventInput[] = [],
  options: { readonly system?: string | null; readonly clock?: TestClock } = {},
): Promise<TestSession> {
  const clock = options.clock ?? createTestClock()
  const store = new InMemorySessionStore({ now: clock.now })
  const agent = await store.createAgent({
    name: 'Summarizer',
    model: { id: TEST_MODEL_ID },
    system: options.system === undefined ? TEST_SYSTEM : options.system,
  })
  const session = await store.createSession(agent.id, { initial_events: initialEvents })
  return { store, sessionId: session.id, clock }
}

/** A message event as a client sends it. */
export function message(text: string): UserEventInput {
  return { type: 'user.message', content: [{ type: 'text', text }] }
}

/** An interrupt event as a client sends it. */
export function interrupt(): UserEventInput {
  return { type: 'user.interrupt' }
}

/** The session's whole log, oldest first, as the store hands it back. */
export async function logOf(
  store: InMemorySessionStore,
  sessionId: SessionId,
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = []
  let afterSeq = 0
  for (;;) {
    const page = await store.listEvents(sessionId, { order: 'asc', afterSeq, limit: 100 })
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

/** Let every queued microtask (a store's delivery, a listener) run before asserting. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
