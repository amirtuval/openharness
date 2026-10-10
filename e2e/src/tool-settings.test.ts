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
 * deterministic model: `GET /v1/me/tools` lists the tool this process registers, `PUT` stores a
 * choice, and the next turn's request offers only what is left on.
 *
 * The log is the evidence, as it is for the loop itself. The mock model calls the test tool on
 * a `__tool__` prompt **whether or not the request offered it** — nothing tells a model what it
 * was offered — so a disabled tool shows up twice over: `span.model_request_start.tools` does
 * not list it, and the call the model made anyway is answered as an unknown tool rather than
 * run. The SDK the server exposes has no tool-settings resource yet (that is the UI, #308), so
 * the routes are called with the harness's own bearer token.
 */

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
  it('lists the registered tool, stores a choice, and drops it from the next request', async () => {
    const server = await harness.server()
    const me = await person(server, 'drops')

    // The mock process registers exactly the test tool, under its own declared `allow`.
    expect(await listTools(server, me)).toEqual([
      {
        name: TEST_TOOL_NAME,
        source: 'builtin',
        enabled: true,
        policy: 'allow',
        default_policy: 'allow',
        available: true,
      },
    ])

    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await sendAndWait(me.client, session.id, `${MOCK_TOOL_MARKER} before the setting`)
    // The tool was offered, so the model's call to it ran and was answered with what it said.
    expect(spans(await readLog(me.client, session.id))[0]?.tools).toEqual([
      { name: TEST_TOOL_NAME, source: 'builtin' },
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

    const log = await readLog(me.client, second.id)
    // The tool was not in the offer at all — the span records no offer, exactly as it does for a
    // deployment that registers no tools.
    expect(spans(log)[0]?.tools).toBeUndefined()
    // The mock called it anyway (nothing told it what the request offered) and the loop, having
    // no tool to run a call with, stores nothing about it: a request that offered no tools has
    // no call in its log, and the turn ends idle behind it.
    expect(log.some((event) => event.type === EVENT_TYPES.agentToolUse)).toBe(false)
    expect(log.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })
})
