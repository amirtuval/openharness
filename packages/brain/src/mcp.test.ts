import { createToolRegistry, textResult } from '@openharness/hands'
import type { ToolDefinition } from '@openharness/hands'
import type { EventId, StoredEvent } from '@openharness/protocol'
import {
  EVENT_TYPES,
  isToolCallEvent,
  isToolResultEvent,
  mcpToolOfferedName,
} from '@openharness/protocol'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { combineTools, resolveMcpTools, type McpOfferedTool, type McpToolProvider } from './mcp'
import { eventTypes, logOf, message, newSession, spanStartOf } from './testing/harness'
import type { MockModel, PromptMessage } from './testing/mock-model'
import { mockModel, readPrompt, resolveTestCredential } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * Remote MCP tools in the loop (epic #303, X10; issue #312).
 *
 * Driven through `runTurn` against a real store, with a scripted model and a stub provider: the
 * provider is where the network and the credentials would be, so what is tested here is what the
 * loop does with a listing — the pair it writes, the offer it records, the pause a remote tool's
 * default policy causes, the crash rule, and the notices a server that cannot be listed gets.
 * The MCP client itself, the guard on a user's URL and the shaping of a real server's answer are
 * `@openharness/hands`' own tests.
 */

/** A tool this build registers, so a request has both kinds to offer. */
const echoTool: ToolDefinition<{ text: string }> = {
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: z.object({ text: z.string() }),
  permission: 'allow',
  run: (input) => textResult(input.text),
}

/** A remote tool, as a host that listed one hands it over. */
function remoteTool(
  serverName: string,
  toolName: string,
  run: ToolDefinition['run'] = () => textResult('the answer'),
  overrides: Partial<ToolDefinition> = {},
): McpOfferedTool {
  const definition: ToolDefinition = {
    name: mcpToolOfferedName(serverName, toolName),
    description: `${toolName} on ${serverName}`,
    // The remote server's arguments are the server's contract; the registry validates only
    // that a call is an object (see `createMcpTool` in `@openharness/hands`).
    inputSchema: z.looseObject({}),
    inputJson: { type: 'object', properties: { query: { type: 'string' } } },
    permission: 'ask',
    run,
    ...overrides,
  }
  return { serverName, toolName, definition }
}

/** A provider that answers the same offer every time it is asked. */
function providerOf(tools: readonly McpOfferedTool[]): McpToolProvider {
  return () => ({ tools, failures: [] })
}

/** Every event of a type, in order. */
function of(events: readonly StoredEvent[], type: string): StoredEvent[] {
  return events.filter((event) => event.type === type)
}

/** The one call in a log, whatever pair it belongs to. */
function callOf(events: readonly StoredEvent[]): StoredEvent & { id: EventId } {
  const call = events.find(isToolCallEvent)
  if (call === undefined) {
    throw new Error('the log holds no tool call')
  }
  return call
}

/** The text a result's blocks carry. */
function resultText(events: readonly StoredEvent[]): string {
  const result = events.find(isToolResultEvent)
  return (result?.content ?? []).map((block) => block.text).join('')
}

/** What the loop sent the model on one request. */
function promptOf(model: MockModel, index: number): PromptMessage[] {
  const call = model.calls[index]
  if (call === undefined) {
    throw new Error(`the loop made no request ${index}`)
  }
  return readPrompt(call)
}

/** What the tool results of one request's prompt carried, in order. */
function toolResultsOf(model: MockModel, index: number): string[] {
  const call = model.calls[index]
  if (call === undefined) {
    throw new Error(`the loop made no request ${index}`)
  }
  return call.prompt.flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.flatMap((part) =>
          part.type === 'tool-result' && part.output.type === 'text' ? [part.output.value] : [],
        ),
  )
}

/** The names the model was offered on one request, and their schemas. */
function offeredOf(
  model: MockModel,
  index: number,
): readonly { readonly name: string; readonly inputSchema: unknown }[] {
  const call = model.calls[index]
  if (call === undefined) {
    throw new Error(`the loop made no request ${index}`)
  }
  return (call.tools ?? []).map((tool) => ({
    name: tool.name,
    inputSchema: tool.type === 'function' ? tool.inputSchema : undefined,
  }))
}

describe('resolveMcpTools', () => {
  const base = createToolRegistry([echoTool])

  it('answers nothing for a host with no MCP at all', async () => {
    const resolved = await resolveMcpTools(undefined, base, 'user_1', null)
    expect(resolved.registry).toBeUndefined()
    expect(resolved.refs.size).toBe(0)
    expect(resolved.failures).toEqual([])
  })

  it('is a registry of the offered tools, with the pair behind each name', async () => {
    const tool = remoteTool('notes', 'search')
    const resolved = await resolveMcpTools(providerOf([tool]), base, 'user_1', null)
    expect(resolved.registry?.tools.map((entry) => entry.name)).toEqual(['notes__search'])
    expect(resolved.refs.get('notes__search')).toEqual({
      serverName: 'notes',
      toolName: 'search',
    })
    expect(resolved.failures).toEqual([])
  })

  it('lets the first claim on an offered name win, so the name stays recomputable', async () => {
    // Two pairs that sanitize to one name: nothing a reader of the log has can tell them apart,
    // so only the first is offered.
    const first = remoteTool('notes', 'find this')
    const second = remoteTool('notes', 'find.this')
    expect(first.definition.name).toBe(second.definition.name)
    const resolved = await resolveMcpTools(providerOf([first, second]), base, 'user_1', null)
    expect(resolved.registry?.tools).toHaveLength(1)
    expect(resolved.refs.get(first.definition.name)).toEqual({
      serverName: 'notes',
      toolName: 'find this',
    })
  })

  it('never lets a remote tool take a name a registered tool already has', async () => {
    const clash = remoteTool('web', 'fetch', () => textResult('x'), { name: 'echo' })
    const resolved = await resolveMcpTools(providerOf([clash]), base, 'user_1', null)
    expect(resolved.registry).toBeUndefined()
    expect(resolved.refs.size).toBe(0)
  })

  it('reports a server once, whatever the host said about it twice', async () => {
    const provider: McpToolProvider = () => ({
      tools: [],
      failures: [
        { serverName: 'notes', kind: 'connection', message: 'down' },
        { serverName: 'notes', kind: 'authentication', message: 'no token' },
      ],
    })
    const resolved = await resolveMcpTools(provider, base, 'user_1', null)
    expect(resolved.failures).toEqual([
      { serverName: 'notes', kind: 'authentication', message: 'no token' },
    ])
  })
})

describe('combineTools', () => {
  it('is one registry, and `undefined` when neither side has anything', () => {
    const base = createToolRegistry([echoTool])
    const remote = createToolRegistry([remoteTool('notes', 'search').definition])
    expect(combineTools(undefined, undefined)).toBeUndefined()
    expect(combineTools(base, undefined)).toBe(base)
    expect(combineTools(undefined, remote)).toBe(remote)
    expect(combineTools(base, remote)?.tools.map((tool) => tool.name)).toEqual([
      'echo',
      'notes__search',
    ])
  })
})

describe('a remote call in the loop', () => {
  it('is stored as the MCP pair, records the server, and is answered in the same pair', async () => {
    const { store, sessionId } = await newSession([message('search my notes')])
    const run = vi.fn(() => textResult('one note'))
    const model = mockModel(
      { toolCalls: [{ name: 'notes__search', input: { query: 'roadmap' } }] },
      { text: ['Found it.'] },
    )

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      toolSettings: () => ({ notes__search: { enabled: true, permission: 'allow' } }),
      mcpTools: providerOf([remoteTool('notes', 'search', run)]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    const call = callOf(log)
    expect(call.type).toBe(EVENT_TYPES.agentMcpToolUse)
    expect(call).toMatchObject({
      mcp_server_name: 'notes',
      // The tool's own name, not the model-facing one: the log records what the server calls it.
      name: 'search',
      input: { query: 'roadmap' },
      evaluated_permission: 'allow',
    })
    const result = log.find(isToolResultEvent)
    expect(result).toMatchObject({
      type: EVENT_TYPES.agentMcpToolResult,
      mcp_tool_use_id: call.id,
      is_error: false,
    })
    expect(resultText(log)).toBe('one note')
    expect(run).toHaveBeenCalledTimes(1)
    // The answer is what the next request is built from: the model sees a `tool` message.
    expect(promptOf(model, 1).at(-1)?.role).toBe('tool')
    expect(toolResultsOf(model, 1)).toEqual(['one note'])
  })

  it('records the source and the server on the span, and offers the server’s own schema', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel({ text: ['ok'] })

    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: providerOf([remoteTool('notes', 'search')]),
    })

    const log = await logOf(store, sessionId)
    expect(spanStartOf(of(log, EVENT_TYPES.modelRequestStart)[0]).tools).toEqual([
      { name: 'echo', source: 'builtin' },
      { name: 'notes__search', source: 'mcp', server: 'notes' },
    ])
    // The model is shown the parameters the remote server really takes.
    const offered = offeredOf(model, 0)
    expect(offered.map((tool) => tool.name)).toEqual(['echo', 'notes__search'])
    expect(offered[1]?.inputSchema).toMatchObject({ properties: { query: { type: 'string' } } })
  })

  it('offers nothing but this build’s tools when the host lists nothing', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel({ text: ['ok'] })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: providerOf([]),
    })
    const log = await logOf(store, sessionId)
    expect(spanStartOf(of(log, EVENT_TYPES.modelRequestStart)[0]).tools).toEqual([
      { name: 'echo', source: 'builtin' },
    ])
  })
})

describe('a remote tool’s policy', () => {
  it('asks by default, and one confirmation runs it', async () => {
    const { store, sessionId } = await newSession([message('search my notes')])
    const run = vi.fn(() => textResult('one note'))
    const model = mockModel(
      { toolCalls: [{ name: 'notes__search', input: { query: 'x' } }] },
      { text: ['Found it.'] },
    )
    const options = {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: providerOf([remoteTool('notes', 'search', run)]),
    }

    // The tool declares `ask` (the epic's default for a remote tool), so the turn stores the
    // call and stops.
    const paused = await runTurn(sessionId, options)
    expect(paused).toEqual({ outcome: 'paused' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const call = callOf(log)
    expect(call.type).toBe(EVENT_TYPES.agentMcpToolUse)
    expect(call).toMatchObject({ evaluated_permission: 'ask' })
    expect(of(log, EVENT_TYPES.sessionStatusIdle)[0]).toMatchObject({
      stop_reason: { type: 'requires_action', event_ids: [call.id] },
    })

    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.userToolConfirmation,
        tool_use_id: call.id,
        result: 'allow',
        remember: 'session',
      },
    ])
    const outcome = await runTurn(sessionId, options)
    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).toHaveBeenCalledTimes(1)
    const answered = await logOf(store, sessionId)
    expect(answered.find(isToolResultEvent)?.type).toBe(EVENT_TYPES.agentMcpToolResult)

    // `remember: session` is read back off the log: a second call to the same remote tool runs
    // without asking again. A new message starts that turn — the session is idle after the
    // first one, and the approval is remembered for the chat, not for one turn.
    await store.appendEvents(sessionId, [message('and again')])
    const again = mockModel(
      { toolCalls: [{ name: 'notes__search', input: { query: 'y' } }] },
      { text: ['ok'] },
    )
    const second = await runTurn(sessionId, { ...options, model: again.factory })
    expect(second).toEqual({ outcome: 'idle' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('is refused without running when the user says no', async () => {
    const { store, sessionId } = await newSession([message('search my notes')])
    const run = vi.fn(() => textResult('one note'))
    const model = mockModel(
      { toolCalls: [{ name: 'notes__search', input: { query: 'x' } }] },
      { text: ['Fine.'] },
    )
    const options = {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: providerOf([remoteTool('notes', 'search', run)]),
    }
    await runTurn(sessionId, options)
    const call = callOf(await logOf(store, sessionId))
    await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.userToolConfirmation,
        tool_use_id: call.id,
        result: 'deny',
        deny_message: 'Not that server.',
      },
    ])
    await runTurn(sessionId, options)
    expect(run).not.toHaveBeenCalled()
    const result = (await logOf(store, sessionId)).find(isToolResultEvent)
    expect(result?.type).toBe(EVENT_TYPES.agentMcpToolResult)
    expect(result?.is_error).toBe(true)
    expect(resultText(await logOf(store, sessionId))).toContain('Not that server.')
  })
})

describe('a server that cannot be listed', () => {
  it('writes a connection notice and the turn carries on without its tools', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel({ text: ['ok'] })
    const provider: McpToolProvider = () => ({
      tools: [],
      failures: [
        { serverName: 'notes', kind: 'connection', message: 'connect ECONNREFUSED 10.0.0.1.' },
      ],
    })
    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: provider,
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    const log = await logOf(store, sessionId)
    const error = of(log, EVENT_TYPES.sessionError)[0]
    expect(error).toMatchObject({
      error: { type: 'mcp_connection_failed_error', retry_status: { type: 'terminal' } },
    })
    expect(JSON.stringify(error)).toContain('notes')
    expect(JSON.stringify(error)).toContain('continues without its tools')
    // The turn still made its request, and offered no remote tool.
    expect(eventTypes(log)).toContain(EVENT_TYPES.agentMessage)
    expect(spanStartOf(of(log, EVENT_TYPES.modelRequestStart)[0]).tools).toEqual([
      { name: 'echo', source: 'builtin' },
    ])
  })

  it('tells an authentication failure apart, so the user knows to reconnect', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel({ text: ['ok'] })
    const provider: McpToolProvider = () => ({
      tools: [],
      failures: [
        { serverName: 'notes', kind: 'authentication', message: 'the token was refused.' },
      ],
    })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: provider,
    })
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.sessionError)[0]).toMatchObject({
      error: { type: 'mcp_authentication_failed_error' },
    })
  })

  it('says it once per server per turn, however many requests the turn makes', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'hi' } }] },
      { text: ['done'] },
    )
    const provider: McpToolProvider = () => ({
      tools: [],
      failures: [{ serverName: 'notes', kind: 'connection', message: 'down.' }],
    })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: provider,
    })
    const log = await logOf(store, sessionId)
    expect(of(log, EVENT_TYPES.sessionError)).toHaveLength(1)
    expect(of(log, EVENT_TYPES.modelRequestStart)).toHaveLength(2)
  })

  it('stops being offered from the next request on when the host stops listing it', async () => {
    const { store, sessionId } = await newSession([message('go')])
    let asked = 0
    const provider: McpToolProvider = () => {
      asked += 1
      return { tools: asked === 1 ? [remoteTool('notes', 'search')] : [], failures: [] }
    }
    const model = mockModel(
      { toolCalls: [{ name: 'echo', input: { text: 'hi' } }] },
      { text: ['done'] },
    )
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: provider,
    })
    expect(offeredOf(model, 0).map((tool) => tool.name)).toEqual(['echo', 'notes__search'])
    expect(offeredOf(model, 1).map((tool) => tool.name)).toEqual(['echo'])
  })
})

describe('the crash rule', () => {
  it('answers an inherited remote call execution lost, and never runs it', async () => {
    // A log a dead brain left: a remote call with no answer, and a message waiting behind it.
    const { store, sessionId } = await newSession([message('go')])
    const [call] = await store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.agentMcpToolUse,
        mcp_server_name: 'notes',
        name: 'search',
        input: { query: 'x' },
        evaluated_permission: 'allow',
      },
    ])
    const run = vi.fn(() => textResult('never'))
    const model = mockModel({ text: ['ok'] })

    const outcome = await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      mcpTools: providerOf([remoteTool('notes', 'search', run)]),
    })

    expect(outcome).toEqual({ outcome: 'idle' })
    expect(run).not.toHaveBeenCalled()
    const log = await logOf(store, sessionId)
    const result = log.find(isToolResultEvent)
    expect(result).toMatchObject({
      type: EVENT_TYPES.agentMcpToolResult,
      mcp_tool_use_id: call?.id,
      is_error: true,
    })
    expect(resultText(log)).toContain('execution lost')
    expect(resultText(log)).toContain('notes__search')
  })
})

describe('what a remote result may cost a request', () => {
  it('is capped by the remote tool’s own declaration', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const long = 'x'.repeat(400)
    const model = mockModel(
      { toolCalls: [{ name: 'notes__search', input: { query: 'x' } }] },
      { text: ['ok'] },
    )
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      toolSettings: () => ({ notes__search: { enabled: true, permission: 'allow' } }),
      mcpTools: providerOf([
        remoteTool('notes', 'search', () => textResult(long), { maxResultTokens: 10 }),
      ]),
    })
    const log = await logOf(store, sessionId)
    // The stored answer is whole; only the request carries the shorter form.
    expect(resultText(log)).toBe(long)
    const carried = toolResultsOf(model, 1)[0] ?? ''
    expect(carried).toContain('tokens omitted')
    expect(carried.length).toBeLessThan(long.length)
    const truncations = of(log, EVENT_TYPES.modelRequestStart).flatMap((event) =>
      event.type === EVENT_TYPES.modelRequestStart ? (event.truncated?.results ?? []) : [],
    )
    expect(truncations).toHaveLength(1)
    expect(truncations[0]).toMatchObject({
      tool: 'notes__search',
      seq: log.find(isToolResultEvent)?.seq,
    })
  })
})

describe('a step that called both kinds', () => {
  it('keeps each answer in its own pair, in call order', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel(
      {
        toolCalls: [
          { name: 'notes__search', input: { query: 'a' } },
          { name: 'echo', input: { text: 'b' } },
        ],
      },
      { text: ['ok'] },
    )
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      toolSettings: () => ({ notes__search: { enabled: true, permission: 'allow' } }),
      mcpTools: providerOf([remoteTool('notes', 'search')]),
    })
    const log = await logOf(store, sessionId)
    const calls = log.filter(isToolCallEvent)
    const results = log.filter(isToolResultEvent)
    expect(calls.map((call) => call.type)).toEqual([
      EVENT_TYPES.agentMcpToolUse,
      EVENT_TYPES.agentToolUse,
    ])
    expect(results.map((result) => result.type)).toEqual([
      EVENT_TYPES.agentMcpToolResult,
      EVENT_TYPES.agentToolResult,
    ])
    expect(results[0]).toMatchObject({ mcp_tool_use_id: calls[0]?.id })
    expect(results[1]).toMatchObject({ tool_use_id: calls[1]?.id })
  })

  it('keeps a disabled remote tool out of the offer entirely', async () => {
    const { store, sessionId } = await newSession([message('go')])
    const model = mockModel({ text: ['ok'] })
    await runTurn(sessionId, {
      store,
      model: model.factory,
      resolveCredential: resolveTestCredential,
      tools: createToolRegistry([echoTool]),
      toolSettings: () => ({ notes__search: { enabled: false, permission: 'ask' } }),
      mcpTools: providerOf([remoteTool('notes', 'search')]),
    })
    const log = await logOf(store, sessionId)
    expect(spanStartOf(of(log, EVENT_TYPES.modelRequestStart)[0]).tools).toEqual([
      { name: 'echo', source: 'builtin' },
    ])
  })
})
