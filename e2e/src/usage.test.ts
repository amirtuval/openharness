import { EVENT_TYPES, type SessionUsageEvent } from '@openharness/protocol'
import type { Client } from '@openharness/client'
import { MOCK_MODEL_USAGE } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  e2eHarness,
  personFor,
  readLog,
  waitForTurnEnd,
  type Person,
  type ServerProcess,
} from './harness'

/**
 * Usage and cost, from the outside (epic #245, A2; issue #247).
 *
 * A real server process, a real Postgres, the deterministic model (42 input, 17 output tokens a
 * request) and the SDK the web app and the CLI both use. What this file proves that no
 * single-package suite can: that the prices the server reads out of its vendored snapshot reach
 * a client through the API, that the running totals the brain writes are in the *stored* log
 * (so a replay equals the live stream), and that the per-user read groups a real request by the
 * caller's own day.
 *
 * The session runs `anthropic/claude-sonnet-5`, which models.dev prices at $2/Mtok in and
 * $10/Mtok out: a request is $0.000084 + $0.00017, and two requests are twice that.
 */

const harness = e2eHarness('usage')

/** The model every session here runs — one the snapshot prices. */
const MODEL = 'anthropic/claude-sonnet-5'

/** Cost of one mock request at that model's rates, in USD. */
const REQUEST_COST =
  (MOCK_MODEL_USAGE.input_tokens * 2 + MOCK_MODEL_USAGE.output_tokens * 10) / 1_000_000

/**
 * A session on {@link MODEL} with `turns` finished turns behind it.
 *
 * The wait names the message that turn started (`afterSeq`): between the POST and the brain's
 * `session.status_running` the session still reads idle, so a wait that does not say which
 * turn it means can return before that turn began.
 */
async function sessionWithTurns(client: Client, turns = 1): Promise<string> {
  const session = await client.sessions.create({ model: { id: MODEL } })
  for (let turn = 0; turn < turns; turn += 1) {
    const sent = await client.sendMessage(session.id, `request ${String(turn)}`)
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })
  }
  return session.id
}

/** A session on {@link MODEL} with one finished turn behind it, for an account of its own. */
async function soloSession(server: ServerProcess, email: string): Promise<Client> {
  const client = await harness.client(server, { email, password: `${email}-password` })
  await sessionWithTurns(client, 1)
  return client
}

/** The day an instant falls on in a zone, as the server reads one: `YYYY-MM-DD`. */
function localDay(tz: string, instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const partOf = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`
}

/** Two signed-in people on one server, for the ownership test. */
async function twoPeople(server: ServerProcess): Promise<{ a: Person; b: Person }> {
  return {
    a: personFor(
      server,
      await harness.user(server, { email: 'usage-a@example.test', password: 'usage-a-password' }),
    ),
    b: personFor(
      server,
      await harness.user(server, { email: 'usage-b@example.test', password: 'usage-b-password' }),
    ),
  }
}

describe('a session’s usage', () => {
  it('sums the requests, prices them, and is in the stored log as well', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const sessionId = await sessionWithTurns(client, 2)

    const usage = await client.usage.session(sessionId)
    expect(usage.session_id).toBe(sessionId)
    expect(usage.totals).toEqual({
      input_tokens: MOCK_MODEL_USAGE.input_tokens * 2,
      output_tokens: MOCK_MODEL_USAGE.output_tokens * 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(usage.by_model).toEqual([
      {
        model: MODEL,
        usage: usage.totals,
        requests: 2,
        cost: usage.cost,
        unpriced_requests: 0,
      },
    ])
    // Two requests at the model's list rates, computed by the server from the vendored prices.
    // Every request was priced, so nothing is left out of the total (#247).
    expect(usage.cost).toBeCloseTo(REQUEST_COST * 2, 12)
    expect(usage.unpriced_requests).toBe(0)

    // The running totals the brain wrote are in the *stored* log (#247): a replay answers what
    // the live stream did, and the newest event carries the session's whole history — tokens and
    // request counts per model, and no money (cost is computed on read, never stored).
    const log = await readLog(client, sessionId)
    const stored = log.filter(
      (event): event is SessionUsageEvent => event.type === EVENT_TYPES.sessionUsage,
    )
    expect(stored).toHaveLength(2)
    expect(stored[0]?.input_tokens).toBe(MOCK_MODEL_USAGE.input_tokens)
    expect(stored[1]).toMatchObject({
      input_tokens: usage.totals.input_tokens,
      output_tokens: usage.totals.output_tokens,
      models: [{ model: MODEL, usage: usage.totals, requests: 2 }],
    })
  })

  it('is owner-scoped: another person’s session is the 404 an unknown id gets', async () => {
    const server = await harness.server()
    const { a, b } = await twoPeople(server)
    const sessionId = await sessionWithTurns(a.client)

    await expect(a.client.usage.session(sessionId)).resolves.toMatchObject({
      session_id: sessionId,
    })
    // B does not learn that A's session exists — and B's own usage is B's, which is nothing.
    await expect(b.client.usage.session(sessionId)).rejects.toMatchObject({
      status: 404,
      type: 'not_found_error',
    })
    const theirs = await b.client.usage.me({ from: '2000-01-01', to: '2100-01-01', tz: 'UTC' })
    expect(theirs.totals.input_tokens).toBe(0)
    expect(theirs.by_model).toEqual([])
    expect(theirs.cost).toBeNull()
    expect(theirs.unpriced_requests).toBe(0)
  })
})

describe('a user’s usage', () => {
  it('answers the range by model and by day, in the zone it was asked for', async () => {
    const server = await harness.server()
    // An account of its own: the per-user route sums every session its caller has, and the
    // file's other tests ran turns too.
    const client = await soloSession(server, 'usage-solo@example.test')
    const sessionId = (await client.sessions.list()).data[0]?.id ?? ''

    const today = new Date().toISOString().slice(0, 10)
    const usage = await client.usage.me({ from: today, to: today, tz: 'UTC' })

    expect(usage).toMatchObject({ from: today, to: today, tz: 'UTC' })
    expect(usage.totals.input_tokens).toBe(MOCK_MODEL_USAGE.input_tokens)
    expect(usage.by_model.map((entry) => entry.model)).toEqual([MODEL])
    // `searches` is the count epic #303's built-ins add (#305): this chat called no tool, so
    // the day holds none — and it is a count, never a price.
    expect(usage.by_day).toEqual([
      { day: today, totals: usage.totals, cost: usage.cost, unpriced_requests: 0, searches: 0 },
    ])
    expect(usage.searches).toBe(0)

    // The same request, read in a zone on the other side of the date line: it is in a
    // *different* local day there — which is what "the reader's days" means, and why the zone
    // travels with the request rather than being the server's.
    const kiritimati = await client.usage.me({
      from: '2000-01-01',
      to: '2100-01-01',
      tz: 'Pacific/Kiritimati',
    })
    expect(kiritimati.tz).toBe('Pacific/Kiritimati')
    expect(kiritimati.by_day.map((day) => day.day)).toEqual([localDay('Pacific/Kiritimati')])
    expect(kiritimati.totals.input_tokens).toBe(MOCK_MODEL_USAGE.input_tokens)

    // A day the session did not run on is empty rather than zeroed.
    const yesterday = await client.usage.me({ from: '1999-12-31', to: '1999-12-31', tz: 'UTC' })
    expect(yesterday.totals.input_tokens).toBe(0)
    expect(yesterday.by_day).toEqual([])

    // And a session that was deleted is gone from the totals like everything else it owned.
    await client.sessions.delete(sessionId)
    const after = await client.usage.me({ from: today, to: today, tz: 'UTC' })
    expect(after.totals.input_tokens).toBe(0)
    expect(after.by_day).toEqual([])
  })

  it('refuses a zone the server does not know, and a range that ends before it starts', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    await expect(client.usage.me({ tz: 'Mars/Phobos' })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    await expect(
      client.usage.me({ from: '2026-10-08', to: '2026-10-01', tz: 'UTC' }),
    ).rejects.toMatchObject({ status: 400, type: 'invalid_request_error' })
  })
})
