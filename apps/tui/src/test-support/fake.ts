import type { Client } from '@openharness/client'
import type { FakeClient } from '@openharness/client/testing'
import type { Agent, Session } from '@openharness/protocol'

/** How many rows one page holds in {@link pagedAgents} and {@link pagedSessions}. */
const PAGE_SIZE = 20

/**
 * The fake client with a different agent list.
 *
 * Used for the cases the fake cannot seed: several agents to choose between, and none at
 * all. Everything else — sessions, the event log, the scripted brain — is untouched, so a
 * test only has to say what it is about.
 */
export function listingAgents(fake: FakeClient, agents: readonly Agent[]): Client {
  return {
    ...fake,
    agents: {
      ...fake.agents,
      list: () => Promise.resolve({ data: [...agents], next_page: null }),
    },
  }
}

/** The fake client with a different session list, for `--continue`. */
export function listingSessions(fake: FakeClient, ids: readonly string[]): Client {
  return {
    ...fake,
    sessions: {
      ...fake.sessions,
      list: () =>
        Promise.resolve({
          data: ids.map((id, index) => ({
            ...fake.session,
            id: id as typeof fake.session.id,
            title: `session ${String(index)}`,
          })),
          next_page: null,
        }),
    },
  }
}

/** A list request's `limit` and `page`, the only parameters the paging helpers need. */
interface PageParams {
  readonly limit?: number | undefined
  readonly page?: string | undefined
}

/**
 * A list served one page at a time, the way a server serves it.
 *
 * A page holds at most `pageSize` rows even when the caller asked for more: a server is
 * allowed to answer with fewer rows than `limit` while it still has some, which is what
 * makes `next_page` load-bearing. The cursor is the position the next page starts at — text
 * this helper writes and reads back, and the CLI never looks inside, because cursors are
 * opaque.
 */
function pagedList<T>(all: readonly T[], pageSize: number) {
  return (params: PageParams | undefined) => {
    const page = params?.page
    const start = page !== undefined && /^\d+$/u.test(page) ? Number.parseInt(page, 10) : 0
    const data = all.slice(start, start + Math.min(params?.limit ?? pageSize, pageSize))
    const next = start + data.length
    return Promise.resolve({ data, next_page: next < all.length ? String(next) : null })
  }
}

/**
 * The fake client with its agents served in pages of `pageSize`.
 *
 * For the tests that need a list longer than one page: everything past the first answer is
 * only reachable by following `next_page`, which is exactly the bug these tests are about.
 * The agents must be the ones the fake holds (see {@link seedAgents}), because a session is
 * only created for an agent the client knows.
 */
export function pagedAgents(
  fake: FakeClient,
  agents: readonly Agent[],
  pageSize = PAGE_SIZE,
): Client {
  const pages = pagedList(agents, pageSize)
  return {
    ...fake,
    agents: {
      ...fake.agents,
      list: (params) => pages(params),
    },
  }
}

/**
 * The fake client with its sessions served in pages of `pageSize`, as {@link pagedAgents}
 * serves agents.
 */
export function pagedSessions(
  fake: FakeClient,
  sessions: readonly Session[],
  pageSize = PAGE_SIZE,
): Client {
  const pages = pagedList(sessions, pageSize)
  return {
    ...fake,
    sessions: {
      ...fake.sessions,
      list: (params) => pages(params),
    },
  }
}

/** Create `count` agents named `Agent 01` … `Agent NN`, in that order. */
export async function seedAgents(fake: FakeClient, count: number): Promise<Agent[]> {
  const agents: Agent[] = []
  for (let index = 1; index <= count; index += 1) {
    agents.push(
      await fake.agents.create({
        name: `Agent ${String(index).padStart(2, '0')}`,
        model: { id: 'anthropic/claude-sonnet-5' },
      }),
    )
  }
  return agents
}

/** Create `count` sessions titled `Session 01` … `Session NN`, in that order. */
export async function seedSessions(fake: FakeClient, count: number): Promise<Session[]> {
  const sessions: Session[] = []
  for (let index = 1; index <= count; index += 1) {
    sessions.push(
      await fake.sessions.create({
        agent: fake.agent.id,
        title: `Session ${String(index).padStart(2, '0')}`,
      }),
    )
  }
  return sessions
}

/**
 * The fake client with one call replaced, for the failures a real server can answer with.
 *
 * The reason is wrapped when it is not already an `Error`, because rejecting with anything
 * else is a lint error and, more to the point, not what a client ever throws.
 */
export function failing(
  client: Client,
  method: 'sendMessage' | 'interrupt',
  error: unknown,
): Client {
  const reason = error instanceof Error ? error : new Error(String(error))
  return {
    ...client,
    [method]: () => Promise.reject(reason),
  }
}
