import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@openharness/hands'
import { MOCK_TOOL_MARKER, TEST_TOOL_NAME } from '@openharness/server'
import { EVENT_TYPES } from '@openharness/protocol'
import type {
  AgentToolResultEvent,
  AgentToolUseEvent,
  ModelRequestStartEvent,
  StoredEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { e2eHarness, readLog, typesOf, waitForTurnEnd } from './harness'

/**
 * A tool turn, through the real thing (epic #303, #304).
 *
 * The whole loop is exercised against a built server, a real Postgres and the server's
 * deterministic model: the model asks for the `echo` tool, the brain stores the call, runs it
 * through `@openharness/hands` in the server process, stores the answer and asks again — and
 * what a client reads back is the sequence of events that says so. Nothing below is mocked
 * except the model, which is the mock the deployment's test mode is for.
 */

const harness = e2eHarness('tools')

/** The calls and answers of a log, in order. */
function toolEvents(log: readonly StoredEvent[]): {
  readonly uses: readonly AgentToolUseEvent[]
  readonly results: readonly AgentToolResultEvent[]
  readonly spans: readonly ModelRequestStartEvent[]
} {
  return {
    uses: log.filter(
      (event): event is AgentToolUseEvent => event.type === EVENT_TYPES.agentToolUse,
    ),
    results: log.filter(
      (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
    ),
    spans: log.filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    ),
  }
}

describe('a tool turn', () => {
  it('runs the tool the model asked for and answers with its result', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

    await client.sendMessage(session.id, `${MOCK_TOOL_MARKER} ping through the real server`)
    await waitForTurnEnd(client, session.id)

    const log = await readLog(client, session.id)
    const { uses, results, spans } = toolEvents(log)

    // One call, run once, answered once — and the turn ended idle behind it.
    expect(uses).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(uses[0]).toMatchObject({
      name: TEST_TOOL_NAME,
      input: { text: 'ping through the real server' },
      evaluated_permission: 'allow',
    })
    expect(results[0]).toMatchObject({
      tool_use_id: uses[0]?.id,
      content: [{ type: 'text', text: 'ping through the real server' }],
      is_error: false,
    })

    // The step's own request offered the tool before it was called, and the answer bought a
    // second request — which is where the model's reply to the result comes from.
    //
    // The offer is the process's whole registry (epic #303, #305): the test `echo` tool beside
    // the built-ins every deployment gets. `web_search` is not among them, because this server
    // runs with no `OPENHARNESS_SEARCH_API_KEY` — a deployment with no search provider offers
    // no search tool rather than one that always fails.
    const offered = [
      { name: TEST_TOOL_NAME, source: 'builtin' },
      { name: WEB_FETCH_TOOL_NAME, source: 'builtin' },
      { name: 'todo_write', source: 'builtin' },
    ]
    expect(spans).toHaveLength(2)
    expect(spans[0]?.tools).toEqual(offered)
    expect(spans[1]?.tools).toEqual(offered)
    expect(spans[0]?.tools?.map((tool) => tool.name)).not.toContain(WEB_SEARCH_TOOL_NAME)

    // The order the log holds is the order the loop ran in.
    const types = typesOf(log)
    const useAt = types.indexOf(EVENT_TYPES.agentToolUse)
    const resultAt = types.indexOf(EVENT_TYPES.agentToolResult)
    const secondSpanAt = types.indexOf(EVENT_TYPES.modelRequestStart, useAt)
    expect(types[useAt - 1]).toBe(EVENT_TYPES.sessionUsage)
    expect(resultAt).toBe(useAt + 1)
    expect(secondSpanAt).toBeGreaterThan(resultAt)
    expect(types.at(-1)).toBe(EVENT_TYPES.sessionStatusIdle)

    // The model was told what the tool said, and said so back.
    expect(
      log
        .filter((event) => event.type === EVENT_TYPES.agentMessage)
        .map((event) => event.content.map((block) => block.text).join(''))
        .join('\n'),
    ).toContain('the tool said: ping through the real server')
  })

  it('offers nothing to a model the registry says cannot call tools', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    // `openai/gpt-3.5-turbo` is a chat model models.dev marks `tool_call: false`, so a request
    // on it offers nothing at all — and the marker that would call the tool is just a message,
    // which is the whole of "a model that cannot call tools chats as it did before". The
    // catalogue's own `tool_call` is asserted in the server's in-process suite: it needs a
    // stored provider key, and the point here is the request the brain builds.
    const session = await client.sessions.create({ model: { id: 'openai/gpt-3.5-turbo' } })
    await client.sendMessage(session.id, `${MOCK_TOOL_MARKER} not for me`)
    await waitForTurnEnd(client, session.id)

    const log = await readLog(client, session.id)
    const { uses, spans } = toolEvents(log)
    expect(uses).toEqual([])
    expect(spans).toHaveLength(1)
    expect(spans[0]?.tools).toBeUndefined()
  })
})
