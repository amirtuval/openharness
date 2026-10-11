import { MOCK_MCP_MARKER } from '@openharness/server'
import { EVENT_TYPES, mcpToolOfferedName } from '@openharness/protocol'
import type {
  AgentMcpToolResultEvent,
  AgentMcpToolUseEvent,
  ModelRequestStartEvent,
  StoredEvent,
} from '@openharness/protocol'
import { afterAll, describe, expect, it } from 'vitest'

import {
  e2eHarness,
  personFor,
  readLog,
  typesOf,
  waitFor,
  waitForTurnEnd,
  type Person,
} from './harness'
import { startStubMcpServer, type StubMcpServer } from './harness/mcp'

/**
 * A remote MCP tool turn, through the real thing (epic #303, X10; #312).
 *
 * The whole path against a built server, a real Postgres and a real MCP server on loopback: the
 * server lists the registered server's tools through its guarded fetch, the model asks for one,
 * the brain stores the call, the loop calls the tool over the wire, stores the answer and asks
 * again — and what a client reads back is the log that says so. The stub is a plain JSON-RPC
 * MCP server (see `./harness/mcp`), so what the product speaks is checked against the protocol
 * rather than against the SDK it happens to use.
 */

const harness = e2eHarness('mcp-tools')

/**
 * The one server this file runs against.
 *
 * One process for the file rather than one per test: every test shares the database, and a
 * second process on it would be a second scheduler that could pick up the first one's work. The
 * tests are isolated by **account** instead — each registers its servers under its own person —
 * which is the boundary a server resource really has.
 */
async function sharedServer(): Promise<Awaited<ReturnType<typeof harness.server>>> {
  server ??= await harness.server({ env: { OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: '1' } })
  return server
}
let server: Awaited<ReturnType<typeof harness.server>> | undefined

const stubs: StubMcpServer[] = []

/** One account per test: a server registered by one is never in another's offer. */
const ASK_ACCOUNT = { email: 'mcp-ask@example.com', password: 'mcp-ask-password' } as const
const DOWN_ACCOUNT = { email: 'mcp-down@example.com', password: 'mcp-down-password' } as const
const OFF_ACCOUNT = { email: 'mcp-off@example.com', password: 'mcp-off-password' } as const

afterAll(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

/** A stub MCP server, torn down with the file. */
async function stubServer(
  options?: Parameters<typeof startStubMcpServer>[0],
): Promise<StubMcpServer> {
  const stub = await startStubMcpServer(options)
  stubs.push(stub)
  return stub
}

/**
 * Register a server through the route, as a user would, and answer its id.
 *
 * The name is the caller's: a user's server names are unique, and the tests share one account
 * (the harness signs in once per account per server), so each test names its own.
 */
async function register(
  person: Person,
  server: { readonly baseUrl: string },
  name: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${server.baseUrl}/v1/me/mcp_servers`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${person.signedIn.token}`,
    },
    body: JSON.stringify({ name, enabled: true, auth: 'none', ...body }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { readonly id: string }).id
}

/** The tools a caller's settings screen lists. */
async function toolEntries(
  person: Person,
  server: { readonly baseUrl: string },
): Promise<
  { readonly name: string; readonly policy: string; readonly default_policy: string | null }[]
> {
  const response = await fetch(`${server.baseUrl}/v1/me/tools`, {
    headers: { authorization: `Bearer ${person.signedIn.token}` },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    readonly data: {
      readonly name: string
      readonly policy: string
      readonly default_policy: string | null
    }[]
  }
  return body.data
}

/** Set one remote tool's policy, the way the settings screen does. */
async function setPolicy(
  person: Person,
  server: { readonly baseUrl: string },
  name: string,
  policy: string,
): Promise<void> {
  const response = await fetch(`${server.baseUrl}/v1/me/tools`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${person.signedIn.token}`,
    },
    body: JSON.stringify({ mcp: { [name]: policy } }),
  })
  expect(response.status).toBe(200)
}

/** One message to a session, as a client sends it. */
async function say(person: Person, sessionId: string, text: string): Promise<void> {
  await person.client.sessions.events.send(sessionId, {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text }],
  })
}

/** Every event of a type, in order. */
function of<T extends StoredEvent>(log: readonly StoredEvent[], type: string): T[] {
  return log.filter((event) => event.type === type) as T[]
}

/**
 * The remote call a session is waiting on, waited for.
 *
 * The wait is the log's own fact: the turn has ended and its idle names a call — and the call
 * is an `agent.mcp_tool_use`, which is what says the pause is this server's tool rather than a
 * built-in one. `undefined` means "not yet" to `waitFor`, so a turn still running is waited out
 * rather than reported.
 */
async function pausedRemoteCall(person: Person, sessionId: string): Promise<AgentMcpToolUseEvent> {
  return await waitFor(
    `session ${sessionId} to pause on a remote call`,
    async () => {
      const log = await readLog(person.client, sessionId)
      const idle = of(log, EVENT_TYPES.sessionStatusIdle).at(-1)
      if (
        idle?.type !== EVENT_TYPES.sessionStatusIdle ||
        idle.stop_reason.type !== 'requires_action'
      ) {
        return undefined
      }
      return of<AgentMcpToolUseEvent>(log, EVENT_TYPES.agentMcpToolUse)[0]
    },
    {
      describe: async () => {
        const log = await readLog(person.client, sessionId)
        return typesOf(log).join(', ')
      },
    },
  )
}

describe('a remote MCP tool through the real server', () => {
  it('lists the server, asks by default, calls on approval and answers with the result', async () => {
    const stub = await stubServer()
    // A loopback MCP server is a user-typed address, so the deployment's self-host setting has
    // to allow it — the same flag a custom OpenAI-compatible endpoint reads (the shared server
    // is started with it).
    const server = await sharedServer()
    // A person of this test's own: a server is a per-user resource, and the tests share one
    // process, so an account each is what keeps one test's servers out of another's offer.
    const me = personFor(server, await harness.user(server, ASK_ACCOUNT))
    await register(me, server, 'notes', { url: stub.url })

    // The settings screen sees the remote tool under its model-facing name, with the epic's
    // `ask` default, grouped by the server it came from.
    const offered = mcpToolOfferedName('notes', 'search')
    const listable = (await toolEntries(me, server)).find((entry) => entry.name === offered)
    expect(listable).toMatchObject({ policy: 'ask', default_policy: 'ask' })
    // A user may choose a policy explicitly; `ask` is what a chat runs until they do.
    await setPolicy(me, server, offered, 'ask')

    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await say(me, session.id, `${MOCK_MCP_MARKER} ${offered} {"query":"roadmap"}`)

    // The turn ends waiting on the user: the policy is `ask`, nothing has been called.
    const call = await pausedRemoteCall(me, session.id)
    expect(call).toMatchObject({
      mcp_server_name: 'notes',
      // The log records the server's own name for its tool, not the model-facing one.
      name: 'search',
      input: { query: 'roadmap' },
      evaluated_permission: 'ask',
    })
    expect(stub.calls).toEqual([])

    // The user allows it: the brain runs the call over the wire and stores the answer in the
    // MCP pair, then asks the model again. The answer is waited for in the log — the
    // confirmation's own turn is bracketed by statuses that come after the pause's idle, so
    // "the turn after the call ended" would otherwise match the pause itself.
    await me.client.sessions.events.send(session.id, {
      type: EVENT_TYPES.userToolConfirmation,
      tool_use_id: call.id,
      result: 'allow',
      remember: 'session',
    })
    const result = await waitFor('the remote call to be answered', async () =>
      of<AgentMcpToolResultEvent>(
        await readLog(me.client, session.id),
        EVENT_TYPES.agentMcpToolResult,
      ).at(-1),
    )
    await waitForTurnEnd(me.client, session.id, { afterSeq: result.seq })

    const log = await readLog(me.client, session.id)
    expect(result).toMatchObject({ mcp_tool_use_id: call.id, is_error: false })
    expect(result?.content.map((block) => block.text).join('')).toContain('roadmap')
    expect(stub.calls).toEqual([{ name: 'search', args: { query: 'roadmap' } }])

    // The span says what the request offered: the process's own tools, and the remote one with
    // the server it came from (epic #303, X1; #312).
    const span = of<ModelRequestStartEvent>(log, EVENT_TYPES.modelRequestStart)[0]
    expect(span?.tools?.filter((tool) => tool.source === 'mcp')).toEqual([
      { name: offered, source: 'mcp', server: 'notes' },
    ])
    // The reply is the model's answer to what the tool said, so the chat really carried on.
    expect(of(log, EVENT_TYPES.agentMessage).length).toBeGreaterThan(0)
  })

  it('turns a server that cannot be reached into a notice, and still answers the chat', async () => {
    const stub = await stubServer()
    const server = await sharedServer()
    const me = personFor(server, await harness.user(server, DOWN_ACCOUNT))
    await register(me, server, 'gone', { url: stub.url })
    // The server goes away after the check that stored it: the turn's listing cannot reach it.
    await stub.close()

    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await say(me, session.id, 'just say hello')
    await waitForTurnEnd(me.client, session.id)

    const log = await readLog(me.client, session.id)
    const error = of(log, EVENT_TYPES.sessionError)[0]
    expect(error).toMatchObject({
      error: { type: 'mcp_connection_failed_error', retry_status: { type: 'terminal' } },
    })
    expect(JSON.stringify(error)).toContain('continues without its tools')
    // The chat answered anyway, and its request offered no remote tool.
    expect(of(log, EVENT_TYPES.agentMessage)).toHaveLength(1)
    const span = of<ModelRequestStartEvent>(log, EVENT_TYPES.modelRequestStart)[0]
    expect(span?.tools?.some((tool) => tool.source === 'mcp')).toBe(false)
  })

  it('is not offered once the user disables the server', async () => {
    const stub = await stubServer()
    const server = await sharedServer()
    const me = personFor(server, await harness.user(server, OFF_ACCOUNT))
    const id = await register(me, server, 'off', { url: stub.url })
    const disabled = await fetch(`${server.baseUrl}/v1/me/mcp_servers/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${me.signedIn.token}`,
      },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)

    const session = await me.client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
    await say(me, session.id, 'just say hello')
    await waitForTurnEnd(me.client, session.id)

    const log = await readLog(me.client, session.id)
    const span = of<ModelRequestStartEvent>(log, EVENT_TYPES.modelRequestStart)[0]
    expect(span?.tools?.some((tool) => tool.source === 'mcp')).toBe(false)
    expect(stub.listings()).toBeGreaterThan(0) // it was listed when it was saved
  })
})
