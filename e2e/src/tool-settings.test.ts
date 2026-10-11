import { WEB_FETCH_TOOL_NAME } from '@openharness/hands'
import { MOCK_TOOL_MARKER, TEST_TOOL_NAME } from '@openharness/server'
import { EVENT_TYPES } from '@openharness/protocol'
import type { ModelRequestStartEvent, StoredEvent, ToolSettingEntry } from '@openharness/protocol'
import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import type { Person, ServerProcess } from './harness'
import { e2eHarness, personFor, readLog, waitForTurnEnd } from './harness'

/**
 * Tool settings, through the real thing (epic #303, X4; issue #307).
 *
 * The whole path is exercised against a built server, a real Postgres and the server's
 * deterministic model: `GET /v1/me/tools` lists the tools this process registers — #305's
 * built-ins beside the test tool, all of them under their declared defaults — `PUT` stores a
 * choice, and the next turn's request offers only what is left on.
 *
 * The log is the evidence, as it is for the loop itself. The mock model calls the test tool on
 * a `__tool__` prompt **whether or not the request offered it** — nothing tells a model what it
 * was offered — so a disabled tool shows up twice over: `span.model_request_start.tools` does
 * not list it, and a call the model made anyway is answered by the registry rather than run
 * (with every tool off, which is an offer of nothing, the call is stored nowhere). The SDK the
 * server exposes has no tool-settings resource yet (that is the UI, #308), so the routes are
 * called with the harness's own bearer token.
 */

/** One listed tool under its own declared `allow`: what `GET /v1/me/tools` answers. */
function listed(name: string, enabled = true): ToolSettingEntry {
  return {
    name,
    source: 'builtin',
    enabled,
    policy: 'allow',
    default_policy: 'allow',
    available: true,
  }
}

const harness = e2eHarness('tool-settings')

/** A person of this file's own, so one test's settings cannot reach the next. */
async function person(server: ServerProcess, label: string): Promise<Person> {
  return personFor(
    server,
    await harness.user(server, {
      email: `${label}@tool-settings.example.com`,
      password: 'e2e-password-123',
    }),
  )
}

/** One `/v1/me/tools` call, as the caller's bearer token. */
async function tools(
  server: ServerProcess,
  person: Person,
  init: RequestInit & { readonly body?: string } = {},
): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/me/tools`, {
    ...init,
    headers: {
      authorization: `Bearer ${person.signedIn.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

/** The entries `GET /v1/me/tools` answers. */
async function listTools(server: ServerProcess, who: Person): Promise<ToolSettingEntry[]> {
  const response = await tools(server, who)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: ToolSettingEntry[] }).data
}

/** The `span.model_request_start` events of a log, in order. */
function spans(log: readonly StoredEvent[]): ModelRequestStartEvent[] {
  return log.filter(
    (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
  )
}

/** Send one message and wait for the turn it starts to end. */
async function sendAndWait(client: Client, sessionId: string, text: string): Promise<void> {
  const sent = await client.sessions.events.send(sessionId, [
    { type: 'user.message', content: [{ type: 'text', text }] },
  ])
  const seq = sent.data[0]?.seq
  await waitForTurnEnd(client, sessionId, seq === undefined ? undefined : { afterSeq: seq })
}

describe('the tool settings over the wire', () => {
  it('lists the registered tools, stores a choice, and drops one from the next request', async () => {
    const server = await harness.server()
    const me = await person(server, 'drops')

    // The mock process registers #305's built-ins and the test tool, in that order, each under
    // its own declared `allow` — the registry the settings and the chat read alike.
    expect(await listTools(server, me)).toEqual([
      listed(TEST_TOOL_NAME),
      listed(WEB_FETCH_TOOL_NAME),
      listed('todo_write'),
    ])

    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await sendAndWait(me.client, session.id, `${MOCK_TOOL_MARKER} before the setting`)
    // Every tool was offered, so the model's call to the test tool ran and was answered with
    // what it said.
    expect(spans(await readLog(me.client, session.id))[0]?.tools).toEqual([
      { name: TEST_TOOL_NAME, source: 'builtin' },
      { name: WEB_FETCH_TOOL_NAME, source: 'builtin' },
      { name: 'todo_write', source: 'builtin' },
    ])

    const stored = await tools(server, me, {
      method: 'PUT',
      body: JSON.stringify({ builtin: { [TEST_TOOL_NAME]: { enabled: false, policy: 'allow' } } }),
    })
    expect(stored.status).toBe(200)
    const written = ((await stored.json()) as { data: ToolSettingEntry[] }).data
    expect(written[0]).toMatchObject({ name: TEST_TOOL_NAME, enabled: false, policy: 'allow' })
    // The read the settings screen makes says the same thing.
    expect((await listTools(server, me))[0]).toMatchObject({ enabled: false })

    const second = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await sendAndWait(me.client, second.id, `${MOCK_TOOL_MARKER} after the setting`)

    // The tool turned off is not in the offer at all; the built-ins the user left on are.
    expect(spans(await readLog(me.client, second.id))[0]?.tools).toEqual([
      { name: WEB_FETCH_TOOL_NAME, source: 'builtin' },
      { name: 'todo_write', source: 'builtin' },
    ])

    // With every tool off the request offers nothing at all, exactly as a deployment that
    // registers none: the span records no offer, and the call the mock model makes anyway is
    // stored nowhere — there is no tool to answer it with — so the turn ends idle behind it.
    const off = await tools(server, me, {
      method: 'PUT',
      body: JSON.stringify({
        builtin: {
          [TEST_TOOL_NAME]: { enabled: false, policy: 'allow' },
          [WEB_FETCH_TOOL_NAME]: { enabled: false, policy: 'allow' },
          todo_write: { enabled: false, policy: 'allow' },
        },
      }),
    })
    expect(off.status).toBe(200)

    const third = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await sendAndWait(me.client, third.id, `${MOCK_TOOL_MARKER} with every tool off`)

    const log = await readLog(me.client, third.id)
    expect(spans(log)[0]?.tools).toBeUndefined()
    expect(log.some((event) => event.type === EVENT_TYPES.agentToolUse)).toBe(false)
    expect(log.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })
})
