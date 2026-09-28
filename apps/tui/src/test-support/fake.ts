import type { Client } from '@openharness/client'
import type { FakeClient } from '@openharness/client/testing'
import type { Agent } from '@openharness/protocol'

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
