import { describe, expect, it } from 'vitest'
import { WEB_FETCH_TOOL_NAME, createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  API_VERSION_PREFIX,
  ASK_USER_TOOL_NAME,
  EVENT_TYPES,
  MESSAGE_PARENT_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  ListToolSettingsResponseSchema,
  ModeSchema,
  SessionSchema,
  type AgentToolResultEvent,
  type AgentToolUseEvent,
  type Mode,
  type ModelRequestStartEvent,
  type Session,
  type SessionId,
  type ToolSettingEntry,
  WEB_SEARCH_TOOL_NAME,
} from '@openharness/protocol'
import { z } from 'zod'

import { createBundledRegistry } from './catalog/registry'
import { toolSettingEntries } from './tool-settings'
import { createTurnRegistry } from './tools'
import {
  asUser,
  createTestApp,
  postJson,
  readHistory,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * Tool settings over HTTP (epic #303, X4; issue #307): `/v1/me/tools`, and the request a chat
 * makes under them.
 *
 * Most of the tools here are test tools of the test's own, so the registry a deployment would
 * register is injected and the settings are exercised over a small, known set; the last block
 * runs the same paths over #305's real built-ins, which is what the two features meeting looks
 * like. Everything else is the production path: the routes, the mode override, the settings
 * resolver the runner hands the brain, and the log the turn writes. A tool a setting turns off
 * has to be absent from the request's `span.model_request_start.tools`, which is the log's own
 * record of what was offered.
 */

const TOOLS = `${API_VERSION_PREFIX}/me/tools`
const MODES = `${API_VERSION_PREFIX}/me/modes`
const SESSIONS = `${API_VERSION_PREFIX}/sessions`

/** Two tools, so a setting that disables one has another to leave alone. */
const REGISTRY = createToolRegistry([tool('web_search'), tool('todo_write')])

/** A tool definition with a declared permission and no side effect. */
function tool(
  name: string,
  permission: ToolDefinition['permission'] = 'allow',
): ToolDefinition<{ query?: string }> {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: z.object({ query: z.string().optional() }),
    permission,
    run: (input) => textResult(`${name}: ${input.query ?? ''}`),
  }
}

/** Create a mode through the route and return it. */
async function createMode(test: TestContext, body: unknown): Promise<Mode> {
  const response = await postJson(test, MODES, body)
  expect(response.status).toBe(201)
  return ModeSchema.parse(await response.json())
}

/** Create a session through the route and return it. */
async function createSession(test: TestContext, body: unknown): Promise<Session> {
  const response = await postJson(test, SESSIONS, body)
  expect(response.status).toBe(201)
  return SessionSchema.parse(await response.json())
}

/** Send one event to a session and assert the append was accepted. */
async function send(test: TestContext, sessionId: SessionId, event: unknown): Promise<void> {
  const response = await postJson(test, `${SESSIONS}/${sessionId}/events`, { events: [event] })
  expect(response.status).toBe(200)
}

/** A `user.message`. */
function message(text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }], ...extra }
}

/** Put a settings body and answer the entries it stored. */
async function putTools(test: TestContext, body: unknown): Promise<ToolSettingEntry[]> {
  const response = await putJson(test, TOOLS, body)
  expect(response.status).toBe(200)
  return ListToolSettingsResponseSchema.parse(await response.json()).data
}

/** A `PUT` of a JSON body, the verb `/v1/me/tools` writes with. */
function putJson(test: TestContext, path: string, body: unknown): Promise<Response> {
  return test.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Save a provider key through the real route, so a mode's model counts as usable (#245 M6). */
async function putKey(test: TestContext, provider: string): Promise<void> {
  const response = await test.request(`${API_VERSION_PREFIX}/provider-credentials/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'api_key', api_key: `sk-test-${provider}-0123456789` }),
  })
  expect(response.status).toBe(200)
}

/** The effective entries `GET /v1/me/tools` answers. */
async function getTools(test: TestContext, query = ''): Promise<ToolSettingEntry[]> {
  const response = await test.request(`${TOOLS}${query}`)
  expect(response.status).toBe(200)
  return ListToolSettingsResponseSchema.parse(await response.json()).data
}

/** The error type of a response body, for the refusals. */
async function errorTypeOf(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { type?: string } }
  return body.error?.type
}

/** The `span.model_request_start` events of a session, in order. */
async function spans(test: TestContext, sessionId: SessionId): Promise<ModelRequestStartEvent[]> {
  return (await readHistory(test.store, sessionId)).filter(
    (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
  )
}

/** The `agent.tool_use` events of a session, in order. */
async function toolUses(test: TestContext, sessionId: SessionId): Promise<AgentToolUseEvent[]> {
  return (await readHistory(test.store, sessionId)).filter(
    (event): event is AgentToolUseEvent => event.type === EVENT_TYPES.agentToolUse,
  )
}

/** The `agent.tool_result` events of a session, in order. */
async function toolResults(
  test: TestContext,
  sessionId: SessionId,
): Promise<AgentToolResultEvent[]> {
  return (await readHistory(test.store, sessionId)).filter(
    (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
  )
}

/** What a result says, as one line. */
function textOf(result: AgentToolResultEvent | undefined): string {
  return result === undefined ? '' : result.content.map((block) => block.text).join('')
}

describe('GET /v1/me/tools', () => {
  it('lists the registered tools under their declared defaults when nothing is stored', async () => {
    const test = createTestApp({ tools: REGISTRY })

    expect(await getTools(test)).toEqual([
      {
        name: 'web_search',
        source: 'builtin',
        enabled: true,
        policy: 'allow',
        default_policy: 'allow',
        available: true,
      },
      {
        name: 'todo_write',
        source: 'builtin',
        enabled: true,
        policy: 'allow',
        default_policy: 'allow',
        available: true,
      },
    ])
  })

  it('reports a tool’s declared default rather than assuming allow', async () => {
    const test = createTestApp({ tools: createToolRegistry([tool('ask_first', 'ask')]) })

    const [entry] = await getTools(test)
    expect(entry).toMatchObject({ name: 'ask_first', policy: 'ask', default_policy: 'ask' })
  })

  it('lists nothing for a deployment that registers no tools', async () => {
    const test = createTestApp()

    expect(await getTools(test)).toEqual([])
  })

  it('lists a stored setting for a tool that is not registered as unavailable', async () => {
    // An app that registers no tools at all — a test's harness, not any deployment, since #305
    // gives every one the built-ins — can still hold a setting for one: a `web_search` whose
    // key this deployment lacks.
    const test = createTestApp()
    await putTools(test, { builtin: { web_search: { enabled: true, policy: 'deny' } } })

    const listed = await getTools(test)
    expect(listed).toEqual([
      {
        name: 'web_search',
        source: 'builtin',
        enabled: true,
        policy: 'deny',
        default_policy: null,
        available: false,
      },
    ])
    // Registered tools come first, in the registry's order, and the extras after them by name.
    const mixed = await getTools(createTestApp({ tools: REGISTRY }))
    expect(mixed.map((entry) => entry.name)).toEqual(['web_search', 'todo_write'])
  })

  it('is the caller’s own, and nobody else sees it', async () => {
    const test = createTestApp({ tools: REGISTRY })
    await putTools(test, { builtin: { web_search: { enabled: false, policy: 'ask' } } })

    const other = await test.signIn('other@example.com')
    const theirs = await test.anonymous(TOOLS, { headers: asUser(other.token) })
    const listed = (await theirs.json()) as { data: ToolSettingEntry[] }
    expect(listed.data.every((entry) => entry.enabled && entry.policy === 'allow')).toBe(true)
  })
})

describe('PUT /v1/me/tools', () => {
  it('merges per tool: a named tool is replaced, the rest keep what is stored', async () => {
    const test = createTestApp({ tools: REGISTRY })

    const first = await putTools(test, {
      builtin: { web_search: { enabled: false, policy: 'deny' } },
    })
    expect(first).toMatchObject([
      { name: 'web_search', enabled: false, policy: 'deny' },
      { name: 'todo_write', enabled: true, policy: 'allow' },
    ])

    // The second write names one tool and leaves the other exactly as the first one left it.
    const second = await putTools(test, {
      builtin: { todo_write: { enabled: true, policy: 'ask' } },
    })
    expect(second).toMatchObject([
      { name: 'web_search', enabled: false, policy: 'deny' },
      { name: 'todo_write', enabled: true, policy: 'ask' },
    ])
    expect(await getTools(test)).toEqual(second)
  })

  it('accepts ask, and an empty body as a no-op', async () => {
    const test = createTestApp({ tools: REGISTRY })
    const stored = await putTools(test, {
      builtin: { web_search: { enabled: true, policy: 'ask' } },
    })
    expect(stored[0]).toMatchObject({ policy: 'ask' })

    expect(await putTools(test, {})).toEqual(stored)
    expect(await putTools(test, { builtin: {} })).toEqual(stored)
  })

  it('refuses a body the protocol does not accept, storing nothing', async () => {
    const test = createTestApp({ tools: REGISTRY })

    const badPolicy = await putJson(test, TOOLS, {
      builtin: { web_search: { enabled: true, policy: 'maybe' } },
    })
    expect(badPolicy.status).toBe(400)
    expect(await errorTypeOf(badPolicy)).toBe('invalid_request_error')

    expect((await putJson(test, TOOLS, { builtin: { '': { enabled: true } } })).status).toBe(400)
    expect((await putJson(test, TOOLS, { builtin: { web_search: {} } })).status).toBe(400)
    expect((await putJson(test, TOOLS, 'nope')).status).toBe(400)

    // Nothing the refused writes carried reached the store.
    expect(await getTools(test)).toMatchObject([
      { name: 'web_search', enabled: true, policy: 'allow' },
      { name: 'todo_write', enabled: true, policy: 'allow' },
    ])
  })
})

describe('a mode’s tool override (#307)', () => {
  it('answers a read as a chat on the mode would see it', async () => {
    const test = createTestApp({ tools: REGISTRY })
    await putTools(test, { builtin: { web_search: { enabled: false, policy: 'deny' } } })
    const mode = await createMode(test, {
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      tools: { builtin: { web_search: true, todo_write: false } },
    })

    // The mode's patch wins where it names a tool and the user's setting stands where it does
    // not; a permission is never the mode's to change.
    expect(await getTools(test, `?mode_id=${mode.id}`)).toMatchObject([
      { name: 'web_search', enabled: true, policy: 'deny', available: true },
      { name: 'todo_write', enabled: false, policy: 'allow', available: true },
    ])
    // The user's own settings are untouched, with and without a mode to ask about.
    expect(await getTools(test)).toMatchObject([
      { name: 'web_search', enabled: false },
      { name: 'todo_write', enabled: true },
    ])
    expect(mode.tools).toEqual({ builtin: { web_search: true, todo_write: false } })
  })

  it('changes nothing for a mode with no override', async () => {
    const test = createTestApp({ tools: REGISTRY })
    const mode = await createMode(test, { name: 'plain', model: 'anthropic/claude-sonnet-5' })

    expect(mode.tools).toBeNull()
    expect(await getTools(test, `?mode_id=${mode.id}`)).toEqual(await getTools(test))
  })

  it('answers 404 for another user’s mode, and 400 for a malformed id', async () => {
    const test = createTestApp({ tools: REGISTRY })
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const other = await test.signIn('other@example.com')

    const theirs = await test.anonymous(`${TOOLS}?mode_id=${mode.id}`, {
      headers: asUser(other.token),
    })
    expect(theirs.status).toBe(404)
    expect((await test.request(`${TOOLS}?mode_id=nope-nope`)).status).toBe(400)
  })

  it('refuses a mode body whose override the protocol does not accept', async () => {
    const test = createTestApp({ tools: REGISTRY })

    expect(
      (
        await postJson(test, MODES, {
          name: 'deep',
          model: 'anthropic/claude-sonnet-5',
          tools: { builtin: { web_search: 'yes' } },
        })
      ).status,
    ).toBe(400)
  })
})

describe('a chat under the settings', () => {
  it('offers the tools a user has on, and drops one they turned off', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [{ text: ['one'] }, { text: ['two'] }],
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await putTools(test, { builtin: { todo_write: { enabled: false, policy: 'allow' } } })

    await send(test, session.id, message('first'))
    await waitForIdle(test.store, session.id)

    expect((await spans(test, session.id))[0]?.tools).toEqual([
      { name: 'web_search', source: 'builtin' },
    ])
  })

  it('offers nothing when every tool is off, exactly as a tools-less deployment does', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [{ text: ['plain'] }],
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await putTools(test, {
      builtin: {
        web_search: { enabled: false, policy: 'allow' },
        todo_write: { enabled: false, policy: 'allow' },
      },
    })

    await send(test, session.id, message('hello'))
    await waitForIdle(test.store, session.id)

    expect((await spans(test, session.id))[0]?.tools).toBeUndefined()
  })

  it('changes the tools from the next request when a message switches the mode', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [{ text: ['one'] }, { text: ['two'] }],
    })
    // Continuing a chat on a mode checks the mode's model is usable, so its provider needs a key.
    await putKey(test, 'openai')
    const mode = await createMode(test, {
      name: 'quiet',
      model: 'openai/gpt-5-mini',
      tools: { builtin: { todo_write: false } },
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })

    await send(test, session.id, message('before the mode'))
    await waitForIdle(test.store, session.id)

    // The message carries the mode, so the chat follows it from that message on — and the
    // request it starts is the first one built under the mode's override.
    await send(test, session.id, message('on the mode now', { mode: mode.id }))
    await waitForIdle(test.store, session.id)

    const starts = await spans(test, session.id)
    expect(starts.map((span) => span.mode?.name)).toEqual([undefined, 'quiet'])
    expect(starts.map((span) => span.tools)).toEqual([
      [
        { name: 'web_search', source: 'builtin' },
        { name: 'todo_write', source: 'builtin' },
      ],
      [{ name: 'web_search', source: 'builtin' }],
    ])
  })

  it('honours a deny: the call is recorded, refused, and never run', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [
        { toolCalls: [{ name: 'web_search', input: { query: 'tools' } }] },
        { text: ['understood'] },
      ],
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await putTools(test, { builtin: { web_search: { enabled: true, policy: 'deny' } } })

    await send(test, session.id, message('search for me'))
    await waitForIdle(test.store, session.id)

    const [call] = await toolUses(test, session.id)
    expect(call).toMatchObject({
      name: 'web_search',
      input: { query: 'tools' },
      evaluated_permission: 'deny',
    })
    // The tool returns `web_search: tools` when it runs, so the denial's own sentence is what
    // proves it did not.
    const result = (await toolResults(test, session.id))[0]
    expect(result).toMatchObject({ is_error: true, tool_use_id: call?.id })
    expect(textOf(result)).toBe('Permission to use web_search has been denied.')
  })

  it('pauses on an ask: the call is recorded, nothing runs it, and the turn waits', async () => {
    const test = createTestApp({
      tools: REGISTRY,
      registry: createBundledRegistry(),
      replies: [
        { toolCalls: [{ name: 'todo_write', input: { query: 'buy milk' } }] },
        { text: ['noted'] },
      ],
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await putTools(test, { builtin: { todo_write: { enabled: true, policy: 'ask' } } })

    await send(test, session.id, message('add a todo'))
    await waitForIdle(test.store, session.id)

    const [call] = await toolUses(test, session.id)
    expect(call).toMatchObject({ name: 'todo_write', evaluated_permission: 'ask' })
    // No result: the user has not answered, and the turn is idle naming the call it waits on.
    expect(await toolResults(test, session.id)).toEqual([])
    const idle = (await readHistory(test.store, session.id))
      .filter((event) => event.type === EVENT_TYPES.sessionStatusIdle)
      .at(-1)
    expect(idle).toMatchObject({
      type: EVENT_TYPES.sessionStatusIdle,
      stop_reason: { type: 'requires_action', event_ids: [call?.id] },
    })
  })
})

describe('the built-in tools under the settings (#305 × #307; #335)', () => {
  /** The registry a deployment on a provider model really runs (`main.ts`'s `createTurnRegistry`). */
  function builtins() {
    return createTurnRegistry({ kind: 'provider' })
  }

  it('lists the built-ins a deployment really registers, and offers them to a chat', async () => {
    const test = createTestApp({
      tools: builtins(),
      registry: createBundledRegistry(),
      replies: [{ text: ['ok'] }],
    })

    // The five subagent tools are registered by every deployment since #344 (a settings screen
    // lists them, and a mode can override one), `web_search` is listed although nothing registers
    // it (#335), and the two built-ins come last.
    expect((await getTools(test)).map((entry) => entry.name)).toEqual([
      ASK_USER_TOOL_NAME,
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
      MESSAGE_PARENT_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
      WEB_SEARCH_TOOL_NAME,
    ])

    // `gpt-5-mini` is a model whose provider has a native search tool, so the request carries it
    // — recorded on the span as `provider`, which is what tells the four apart.
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await send(test, session.id, message('hello'))
    await waitForIdle(test.store, session.id)

    expect((await spans(test, session.id))[0]?.tools).toEqual([
      { name: ASK_USER_TOOL_NAME, source: 'builtin' },
      { name: AGENT_TOOL_NAME, source: 'builtin' },
      { name: AGENT_MESSAGE_TOOL_NAME, source: 'builtin' },
      { name: TASK_WAIT_TOOL_NAME, source: 'builtin' },
      { name: AGENT_STOP_TOOL_NAME, source: 'builtin' },
      { name: MESSAGE_PARENT_TOOL_NAME, source: 'builtin' },
      { name: WEB_FETCH_TOOL_NAME, source: 'builtin' },
      { name: 'todo_write', source: 'builtin' },
      { name: WEB_SEARCH_TOOL_NAME, source: 'provider' },
    ])
  })

  it('does not offer a built-in tool the user turned off', async () => {
    const test = createTestApp({
      tools: builtins(),
      registry: createBundledRegistry(),
      replies: [{ text: ['ok'] }],
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await putTools(test, {
      builtin: {
        [WEB_FETCH_TOOL_NAME]: { enabled: false, policy: 'allow' },
        [WEB_SEARCH_TOOL_NAME]: { enabled: false, policy: 'allow' },
      },
    })

    await send(test, session.id, message('hello'))
    await waitForIdle(test.store, session.id)

    // A tool that is off is not in the offer at all — the model cannot see it — and the span
    // records what was really offered. It holds for the provider-native one too (#335): a
    // search the user turned off is not attached, which is the only meaning `deny` can have
    // for a provider-executed tool.
    expect((await spans(test, session.id))[0]?.tools).toEqual([
      { name: ASK_USER_TOOL_NAME, source: 'builtin' },
      { name: AGENT_TOOL_NAME, source: 'builtin' },
      { name: AGENT_MESSAGE_TOOL_NAME, source: 'builtin' },
      { name: TASK_WAIT_TOOL_NAME, source: 'builtin' },
      { name: AGENT_STOP_TOOL_NAME, source: 'builtin' },
      { name: MESSAGE_PARENT_TOOL_NAME, source: 'builtin' },
      { name: 'todo_write', source: 'builtin' },
    ])
  })

  it('lists web_search as unavailable, and why, on a model that cannot search (#335)', async () => {
    const test = createTestApp({ tools: builtins() })

    // An answer that named no model claims nothing about one, and still lists `web_search`:
    // the tool exists, and only a model decides whether it can be offered.
    const entryOf = (entries: readonly ToolSettingEntry[], name: string) =>
      entries.find((entry) => entry.name === name)
    expect(entryOf(await getTools(test), WEB_SEARCH_TOOL_NAME)).toMatchObject({
      name: WEB_SEARCH_TOOL_NAME,
      source: 'builtin',
      default_policy: 'allow',
      available: true,
    })

    // A chat on a model whose provider has no search tool is told so, and told why.
    const unavailable = await getTools(test, '?model_id=deepseek/deepseek-chat')
    expect(entryOf(unavailable, WEB_SEARCH_TOOL_NAME)).toMatchObject({
      available: false,
      reason: 'This model has no web search.',
    })
    // The built-ins are not model-dependent, and say nothing of the sort.
    expect(entryOf(unavailable, WEB_FETCH_TOOL_NAME)?.reason).toBeUndefined()
    // A model whose provider has one is available again — the question is the model's.
    const available = await getTools(test, '?model_id=anthropic/claude-sonnet-4-5')
    expect(entryOf(available, WEB_SEARCH_TOOL_NAME)).toMatchObject({ available: true })
  })

  it('offers web_search on a searchable model, and a mode can turn it off (#335)', async () => {
    const test = createTestApp({
      tools: builtins(),
      registry: createBundledRegistry(),
      replies: [{ text: ['ok'] }],
    })

    // Continuing a chat on a mode checks the mode's model is usable, so its provider needs a key.
    await putKey(test, 'openai')
    const mode = await createMode(test, {
      name: 'quiet',
      model: 'openai/gpt-5-mini',
      tools: { builtin: { [WEB_SEARCH_TOOL_NAME]: false } },
    })
    const session = await createSession(test, { model: { id: 'openai/gpt-5-mini' } })
    await send(test, session.id, message('on the mode', { mode: mode.id }))
    await waitForIdle(test.store, session.id)

    // The mode's override is applied over the user's settings (which say nothing here), so the
    // provider's search tool is not attached — the settings and the offer meeting in one place.
    expect((await spans(test, session.id))[0]?.tools).toEqual([
      { name: ASK_USER_TOOL_NAME, source: 'builtin' },
      { name: AGENT_TOOL_NAME, source: 'builtin' },
      { name: AGENT_MESSAGE_TOOL_NAME, source: 'builtin' },
      { name: TASK_WAIT_TOOL_NAME, source: 'builtin' },
      { name: AGENT_STOP_TOOL_NAME, source: 'builtin' },
      { name: MESSAGE_PARENT_TOOL_NAME, source: 'builtin' },
      { name: WEB_FETCH_TOOL_NAME, source: 'builtin' },
      { name: 'todo_write', source: 'builtin' },
    ])
  })

  it('refuses an ask policy for web_search, and reads a stored one as allow (#335)', async () => {
    const test = createTestApp({ tools: builtins() })

    // There is no moment at which a provider-executed search could be held for the user, so the
    // write is refused with the reason rather than stored as a switch that can never ask.
    const refused = await putJson(test, TOOLS, {
      builtin: { [WEB_SEARCH_TOOL_NAME]: { enabled: true, policy: 'ask' } },
    })
    expect(refused.status).toBe(400)
    const body = (await refused.json()) as { error?: { type?: string; message?: string } }
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('cannot be set to "ask"')

    // A choice stored before that check existed is read as `allow`: the settings cannot honour
    // an `ask`, so the only two meanings left are `allow` and `deny`, and `ask` is not `deny`.
    const stored = toolSettingEntries(
      createToolRegistry([tool('todo_write')]),
      { builtin: { [WEB_SEARCH_TOOL_NAME]: { enabled: true, policy: 'ask' } }, mcp: {} },
      null,
    )
    expect(stored.find((entry) => entry.name === WEB_SEARCH_TOOL_NAME)).toMatchObject({
      policy: 'allow',
      available: true,
    })
  })
})
