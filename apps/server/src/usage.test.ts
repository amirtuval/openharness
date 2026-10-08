import { describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, ApiErrorBodySchema, SessionUsageSchema } from '@openharness/protocol'
import type { Session, SessionId, SessionUsage, UserUsage } from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'

import { createBundledRegistry } from './catalog/registry'
import { asUser, createTestApp, waitForIdle, type TestContext } from './test-support'

/**
 * `GET /v1/sessions/{session_id}/usage` and `GET /v1/me/usage` (epic #245, A2; issue #247).
 *
 * The reads are over the log the turns really wrote — a scripted model's `span.model_request_end`
 * events — and the prices are the bundled models.dev snapshot's, so the money these tests assert
 * is the arithmetic a deployment does. The clock is the store's, moved by hand, which is what
 * lets a test put two requests on two local days without waiting for one.
 */

/** The model these tests run on: priced by the bundled snapshot (input 2, output 10 /Mtok). */
const PRICED_MODEL = 'anthropic/claude-sonnet-5'

/** A model the snapshot does not carry, so nobody publishes a price for it. */
const UNPRICED_MODEL = 'acme/experimental-9'

/** A clock the test moves by hand, so days and ranges are asserted rather than waited out. */
function movableClock(start: string): { now: () => number; set: (instant: string) => void } {
  let current = new Date(start).getTime()
  return {
    now: () => current,
    set: (instant) => {
      current = new Date(instant).getTime()
    },
  }
}

/** An app on a clock, a store a test can read, and the bundled prices. */
function usageApp(): {
  test: TestContext
  clock: ReturnType<typeof movableClock>
} {
  const clock = movableClock('2026-10-01T00:00:00.000Z')
  const store = new InMemorySessionStore({ now: clock.now })
  return { test: createTestApp({ store, registry: createBundledRegistry() }), clock }
}

/** Create a session over HTTP, on a model the test names. */
async function createSession(test: TestContext, model = PRICED_MODEL): Promise<Session> {
  const response = await test.request(`${API_VERSION_PREFIX}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: { id: model } }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as Session
}

/** Send a message and wait for the turn it starts to finish. */
async function turn(
  test: TestContext,
  sessionId: SessionId,
  options: { readonly text?: string; readonly model?: string; readonly reply?: string[] } = {},
): Promise<void> {
  test.model.push({ text: options.reply ?? ['hi ', 'there'] })
  const body = {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text: options.text ?? 'hello' }],
        ...(options.model === undefined ? {} : { model: { id: options.model } }),
      },
    ],
  }
  const response = await test.request(`${API_VERSION_PREFIX}/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  await waitForIdle(test.store, sessionId)
}

/** `GET /v1/sessions/{session_id}/usage`, parsed. */
async function sessionUsage(
  test: TestContext,
  sessionId: SessionId,
  token?: string,
): Promise<SessionUsage> {
  const response = await test.request(
    `${API_VERSION_PREFIX}/sessions/${sessionId}/usage`,
    token === undefined ? {} : { headers: asUser(token) },
  )
  expect(response.status).toBe(200)
  return SessionUsageSchema.parse(await response.json())
}

/** `GET /v1/me/usage`, raw, so a refusal can be asserted on. */
function userUsageRequest(test: TestContext, query = '', token?: string): Promise<Response> {
  const suffix = query === '' ? '' : `?${query}`
  return test.request(`${API_VERSION_PREFIX}/me/usage${suffix}`, {
    ...(token === undefined ? {} : { headers: asUser(token) }),
  })
}

describe('GET /v1/sessions/{session_id}/usage', () => {
  it('answers zeroed totals, no models and no cost for a session nothing ran on', async () => {
    const { test } = usageApp()
    const session = await createSession(test)

    expect(await sessionUsage(test, session.id)).toEqual({
      session_id: session.id,
      totals: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      // Nothing was spent, and nothing was priced either: a session with no request has no
      // cost to report rather than a `$0.00` that claims its model is free.
      cost: null,
      by_model: [],
    })
  })

  it('sums the requests of a session and prices them with the catalog’s rates', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)

    const usage = await sessionUsage(test, session.id)
    // The scripted model reports 10 input and one token per chunk: two chunks, 10 + 2.
    expect(usage.totals).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(usage.by_model).toEqual([
      {
        model: PRICED_MODEL,
        usage: usage.totals,
        requests: 1,
        cost: usage.cost,
      },
    ])
    // 10 input at $2/Mtok and 2 output at $10/Mtok.
    expect(usage.cost).toBeCloseTo((10 * 2 + 2 * 10) / 1_000_000, 12)
  })

  it('agrees with the session.usage event the turn stored (#247)', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)

    const events = await test.store.listEventsUnscoped(session.id, { types: ['session.usage'] })
    const stored = events.data[0]
    expect(stored?.type).toBe('session.usage')
    const usage = await sessionUsage(test, session.id)
    expect(stored).toMatchObject({
      input_tokens: usage.totals.input_tokens,
      output_tokens: usage.totals.output_tokens,
      models: usage.by_model.map((entry) => ({ model: entry.model, usage: entry.usage })),
    })
  })

  it('breaks the totals down by model when the session switched mid-conversation', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)
    // The switch rides on the next message (epic #116, U3), which is what makes the session's
    // usage a per-model question rather than a single number.
    await turn(test, session.id, {
      text: 'switch please',
      model: UNPRICED_MODEL,
      reply: ['on the ', 'other model'],
    })

    const usage = await sessionUsage(test, session.id)
    // Each model once, and neither outweighs the other here — a tie is broken by id, so the
    // order is a total order whatever the prices turn out to be.
    expect(usage.by_model.map((entry) => entry.model)).toEqual([UNPRICED_MODEL, PRICED_MODEL])
    expect(usage.by_model.map((entry) => entry.requests)).toEqual([1, 1])
    // One of the two models has no published price, so the session's cost is unknown — not the
    // price of the half that happens to be known (#245: a total is never an estimate).
    expect(usage.cost).toBeNull()
    expect(usage.by_model[0]?.cost).toBeNull()
    expect(usage.by_model[1]?.cost).not.toBeNull()
  })

  it('is owner-scoped: another user’s session is the 404 an unknown id gets', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)

    const other = await test.signIn('usage-other@example.com')
    const response = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/usage`, {
      headers: asUser(other.token),
    })
    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')

    // A malformed id is a 400 — it could not name a session even if one existed.
    const malformed = await test.request(`${API_VERSION_PREFIX}/sessions/nope/usage`)
    expect(malformed.status).toBe(400)
  })
})

describe('GET /v1/me/usage', () => {
  it('groups by the reader’s local day, not by UTC', async () => {
    const { test, clock } = usageApp()
    const session = await createSession(test)

    // 20:00Z and 20:10Z are one UTC day; in Asia/Kolkata (UTC+05:30) the first is already the
    // next day. The two requests therefore fall on two local days — which is the whole reason
    // the route takes a zone.
    // 18:00Z and 19:00Z are one UTC day; in Asia/Kolkata (UTC+05:30) they are 23:30 on the 8th
    // and 00:30 on the 9th — two local days, which is the whole reason the route takes a zone.
    clock.set('2026-10-08T18:00:00.000Z')
    await turn(test, session.id)
    clock.set('2026-10-08T19:00:00.000Z')
    await turn(test, session.id)

    const response = await userUsageRequest(test, 'from=2026-10-01&to=2026-10-31&tz=Asia%2FKolkata')
    expect(response.status).toBe(200)
    const usage = (await response.json()) as UserUsage
    expect(usage).toMatchObject({ from: '2026-10-01', to: '2026-10-31', tz: 'Asia/Kolkata' })
    expect(usage.totals.input_tokens).toBe(20)
    expect(usage.by_model.map((entry) => entry.requests)).toEqual([2])
    expect(usage.by_day.map((day) => day.day)).toEqual(['2026-10-08', '2026-10-09'])
    expect(usage.by_day.map((day) => day.totals.input_tokens)).toEqual([10, 10])

    // The same requests read in UTC are one day of 20, which is what "the reader's days" means.
    const utc = (await (
      await userUsageRequest(test, 'from=2026-10-01&to=2026-10-31&tz=UTC')
    ).json()) as UserUsage
    expect(utc.by_day.map((day) => day.day)).toEqual(['2026-10-08'])
    expect(utc.by_day[0]?.totals.input_tokens).toBe(20)

    // A range that covers only the 8th in UTC: the IST read of it is the 8th's evening, which
    // is still inside an October range but not inside a one-day one.
    const oneDay = (await (
      await userUsageRequest(test, 'from=2026-10-08&to=2026-10-08&tz=UTC')
    ).json()) as UserUsage
    expect(oneDay.totals.input_tokens).toBe(20)
    const oneDayIst = (await (
      await userUsageRequest(test, 'from=2026-10-08&to=2026-10-08&tz=Asia%2FKolkata')
    ).json()) as UserUsage
    expect(oneDayIst.totals.input_tokens).toBe(10)
  })

  it('narrows to the days the range names, and defaults to the current month', async () => {
    const { test, clock } = usageApp()
    // The clock moves forward, as a real one does: the session is made in September and its
    // second request lands in October.
    clock.set('2026-09-30T12:00:00.000Z')
    const session = await createSession(test)
    await turn(test, session.id)
    clock.set('2026-10-01T12:00:00.000Z')
    await turn(test, session.id)

    const october = (await (
      await userUsageRequest(test, 'from=2026-10-01&to=2026-10-31&tz=UTC')
    ).json()) as UserUsage
    expect(october.totals.input_tokens).toBe(10)
    expect(october.by_day.map((day) => day.day)).toEqual(['2026-10-01'])

    const september = (await (
      await userUsageRequest(test, 'from=2026-09-01&to=2026-09-30&tz=UTC')
    ).json()) as UserUsage
    expect(september.totals.input_tokens).toBe(10)

    // No parameters at all: the month today is in, so a request with nothing else in it still
    // answers the question the Settings screen opens with.
    const clockNow = new Date()
    const thisMonth = (await (await userUsageRequest(test)).json()) as UserUsage
    expect(thisMonth.tz).toBe('UTC')
    expect(thisMonth.to).toBe(clockNow.toISOString().slice(0, 10))
    expect(thisMonth.from).toBe(`${clockNow.toISOString().slice(0, 7)}-01`)
  })

  it('answers an empty range for days nothing ran on, with no cost', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)

    const empty = (await (
      await userUsageRequest(test, 'from=2026-01-01&to=2026-01-31&tz=UTC')
    ).json()) as UserUsage
    expect(empty.totals.input_tokens).toBe(0)
    expect(empty.by_model).toEqual([])
    expect(empty.by_day).toEqual([])
    expect(empty.cost).toBeNull()
  })

  it('is the caller’s own usage: another account reads theirs and nothing of this one', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)

    const other = await test.signIn('usage-owner@example.com')
    const theirs = (await (
      await userUsageRequest(test, 'from=2026-10-01&to=2026-10-31&tz=UTC', other.token)
    ).json()) as UserUsage
    expect(theirs.totals.input_tokens).toBe(0)
    expect(theirs.by_model).toEqual([])

    const mine = (await (
      await userUsageRequest(test, 'from=2026-10-01&to=2026-10-31&tz=UTC')
    ).json()) as UserUsage
    expect(mine.totals.input_tokens).toBe(10)
  })

  it('refuses a zone the runtime does not know, and a range that ends before it starts', async () => {
    const { test } = usageApp()

    for (const query of ['tz=Mars%2FPhobos', 'tz=Europe%2FNowhere', 'tz=+05:30']) {
      const response = await userUsageRequest(test, query)
      expect(response.status, query).toBe(400)
      expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe(
        'invalid_request_error',
      )
    }

    const backwards = await userUsageRequest(test, 'from=2026-10-08&to=2026-10-01')
    expect(backwards.status).toBe(400)

    // A day that is not a day at all is refused by the query schema, before any zone is read.
    expect((await userUsageRequest(test, 'from=2026-02-30')).status).toBe(400)
  })

  it('does not bill a branch a rewind replaced (#238)', async () => {
    const { test } = usageApp()
    const session = await createSession(test)
    await turn(test, session.id)

    // Edit and resend: the first turn's request is inside the range the rewind supersedes, so
    // the store's replay read leaves it out — and it is not in anybody's usage.
    const first = await test.store.listEventsUnscoped(session.id, { types: ['user.message'] })
    const edited = first.data[0]
    expect(edited).toBeDefined()
    test.model.push({ text: ['the ', 'edited reply'] })
    const response = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          { type: 'session.rewind', from_seq: edited?.seq },
          { type: 'user.message', content: [{ type: 'text', text: 'hello, edited' }] },
        ],
      }),
    })
    expect(response.status).toBe(200)
    await waitForIdle(test.store, session.id)

    const usage = await sessionUsage(test, session.id)
    // One request is left: the one the edited message started.
    expect(usage.by_model[0]?.requests).toBe(1)
    expect(usage.totals.input_tokens).toBe(10)
  })
})
