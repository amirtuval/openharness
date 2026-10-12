import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_API_KEY, WEB_SEARCH_TOOL_NAME } from '@openharness/hands'
import { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { createProviderFetch } from './catalog/provider-fetch'
import { emptyRegistry } from './catalog/registry'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import { createSearchAllowance } from './searches'
import { createTurnTools, TEST_TOOL_NAME, testEchoTool } from './tools'
import type { SearchConfig } from './config'
import type { TurnToolsOptions } from './tools'

/**
 * The tools this server runs with (epic #303; the built-ins are #305).
 *
 * The registry itself is `@openharness/hands`' and is tested there; what this file pins is the
 * server's half: which tools a deployment offers, when `web_search` is one of them, and that
 * the operator's key reaches a step only while the user's allowance lasts.
 */

/** The tools a turn is handed, as `main.ts` builds them. */
function tools(options: {
  readonly kind?: TurnToolsOptions['kind']
  readonly search?: SearchConfig | null
  readonly maxToolSteps?: number
  readonly store?: InMemorySessionStore
}): { names: string[]; turn: ReturnType<typeof createTurnTools>; store: InMemorySessionStore } {
  const store = options.store ?? new InMemorySessionStore()
  const search = options.search ?? null
  const turn = createTurnTools({
    config: { maxToolSteps: options.maxToolSteps ?? 50, search },
    kind: options.kind ?? 'provider',
    registry: emptyRegistry,
    searchTransport: createProviderFetch(),
    allowance:
      search === null ? undefined : createSearchAllowance({ store, dailyLimit: search.dailyLimit }),
  })
  return { names: turn.tools.tools.map((tool) => tool.name), turn, store }
}

const SEARCH: SearchConfig = { provider: 'brave', apiKey: 'operator-key', dailyLimit: 2 }

describe('createTurnTools', () => {
  it('offers the built-in tools to every deployment', () => {
    const { names, turn } = tools({})
    expect(names).toEqual([WEB_FETCH_TOOL_NAME, 'todo_write'])
    expect(turn.maxToolSteps).toBe(50)
    // The gate is wired to the registry, so a model that cannot call tools is offered none.
    expect(turn.toolSupportFor).toBeTypeOf('function')
    // Nothing reaches a secret a deployment did not configure.
    expect(turn.resolveToolSecrets).toBeUndefined()
  })

  it('adds the test tool for the mock model, ahead of the built-ins', () => {
    expect(tools({ kind: 'mock' }).names).toEqual([
      TEST_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
    ])
  })

  it('offers web_search only where an operator configured a search API', () => {
    expect(tools({ search: SEARCH }).names).toEqual([
      WEB_FETCH_TOOL_NAME,
      'todo_write',
      WEB_SEARCH_TOOL_NAME,
    ])
  })

  it('echoes its input back, and reads nothing else', async () => {
    const { turn } = tools({ kind: 'mock', maxToolSteps: 1 })
    expect(await turn.tools.execute(TEST_TOOL_NAME, { text: 'ping' }, {})).toEqual({
      content: [{ type: 'text', text: 'ping' }],
    })
    // An input the tool's own schema refuses is a result, not a throw: the model is told.
    expect(await turn.tools.execute(TEST_TOOL_NAME, {}, undefined)).toMatchObject({
      isError: true,
    })
  })

  it('hands a step the operator’s key while the allowance lasts, and withholds it after', async () => {
    const store = new InMemorySessionStore()
    const { turn } = tools({ search: { ...SEARCH, dailyLimit: 1 }, store })
    const secrets = turn.resolveToolSecrets
    expect(secrets).toBeDefined()
    expect(await secrets?.('user_1')).toEqual({ [WEB_SEARCH_API_KEY]: 'operator-key' })

    // One search, stored as the brain stores it: the call and the result that answers it.
    const session = await store.createSession(null, { ownerId: 'user_1', model: { id: 'a/b' } })
    const [call] = await store.appendEvents(session.id, [
      {
        type: 'agent.tool_use',
        name: WEB_SEARCH_TOOL_NAME,
        input: {},
        evaluated_permission: 'allow',
      },
    ])
    if (call === undefined) {
      throw new Error('the call was not stored')
    }
    await store.appendEvents(session.id, [
      {
        type: 'agent.tool_result',
        tool_use_id: call.id,
        content: [{ type: 'text', text: 'results' }],
        is_error: false,
      },
    ])

    // The allowance is gone, so the key is not: the tool answers with the limit notice, which
    // is the one reason a registered search tool is handed none.
    expect(await secrets?.('user_1')).toEqual({})
    // Another user's day is their own.
    expect(await secrets?.('user_2')).toEqual({ [WEB_SEARCH_API_KEY]: 'operator-key' })
  })

  it('does not depend on the mock env value happening to match', () => {
    // The kind comes from `resolveModelFactory`, which refuses any value but `mock`; this is
    // the string it refuses everything else against, and the one the docs name.
    expect(MOCK_MODEL_ENV_VALUE).toBe('mock')
    expect(testEchoTool.permission).toBe('allow')
  })
})
