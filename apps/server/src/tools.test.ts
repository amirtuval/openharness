import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_API_KEY, WEB_SEARCH_TOOL_NAME } from '@openharness/hands'
import type { ToolRegistry } from '@openharness/hands'
import { ASK_USER_TOOL_NAME } from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { createProviderFetch } from './catalog/provider-fetch'
import { emptyRegistry } from './catalog/registry'
import type { SearchConfig } from './config'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import { createSearchAllowance } from './searches'
import {
  createTestToolRegistry,
  createTurnRegistry,
  createTurnTools,
  TEST_TOOL_NAME,
  testEchoTool,
} from './tools'
import type { TurnToolsOptions } from './tools'

/**
 * The tools this server runs with (epic #303; the built-ins are #305, the per-user settings are
 * #307, and `ask_user` is #309).
 *
 * The registry itself is `@openharness/hands`' and is tested there; what this file pins is the
 * server's half: which tools a deployment registers — the built-ins of #305 and `ask_user` for
 * every process, the test `echo` tool under the mock model — when `web_search` is one of them,
 * that the operator's key reaches a step only while the user's allowance lasts, and that the
 * settings resolver the turn is handed reads the session owner's stored choices.
 */

/** The tools a turn is handed, as `main.ts` builds them. */
function turnTools(
  options: {
    readonly kind?: TurnToolsOptions['kind']
    readonly search?: SearchConfig | null
    readonly maxToolSteps?: number
    readonly store?: InMemorySessionStore
    /** A registry of the test's own, instead of the built-ins the process would register. */
    readonly registry?: ToolRegistry
  } = {},
): { names: string[]; turn: ReturnType<typeof createTurnTools>; store: InMemorySessionStore } {
  const store = options.store ?? new InMemorySessionStore()
  const search = options.search ?? null
  const turn = createTurnTools({
    config: { maxToolSteps: options.maxToolSteps ?? 50, search },
    kind: options.kind ?? 'provider',
    ...(options.registry === undefined ? {} : { tools: options.registry }),
    store,
    registry: emptyRegistry,
    searchTransport: createProviderFetch(),
    allowance:
      search === null ? undefined : createSearchAllowance({ store, dailyLimit: search.dailyLimit }),
  })
  return { names: turn.tools.tools.map((tool) => tool.name), turn, store }
}

const SEARCH: SearchConfig = { provider: 'brave', apiKey: 'operator-key', dailyLimit: 2 }

describe('createTurnRegistry and createTurnTools', () => {
  it('offers the built-ins and ask_user to every deployment', () => {
    const { names, turn } = turnTools({})
    expect(names).toEqual([ASK_USER_TOOL_NAME, WEB_FETCH_TOOL_NAME, 'todo_write'])
    expect(turn.maxToolSteps).toBe(50)
    // The gate is wired to the registry, so a model that cannot call tools is offered none.
    expect(turn.toolSupportFor).toBeTypeOf('function')
    // And the settings resolver (#307) is wired to the store, so a user's choices are read.
    expect(turn.toolSettings).toBeTypeOf('function')
    // Nothing reaches a secret a deployment did not configure.
    expect(turn.resolveToolSecrets).toBeUndefined()
  })

  it('adds the test tool for the mock model, after ask_user and ahead of the built-ins', () => {
    expect(turnTools({ kind: 'mock' }).names).toEqual([
      ASK_USER_TOOL_NAME,
      TEST_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
    ])
  })

  it('offers web_search only where an operator configured a search API', () => {
    expect(turnTools({ search: SEARCH }).names).toEqual([
      ASK_USER_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
      WEB_SEARCH_TOOL_NAME,
    ])
  })

  it('reads the owner’s stored choices through the resolver it wires (#307)', async () => {
    const store = new InMemorySessionStore()
    // A registry of the test's own, so the answer has exactly two tools to speak about: the
    // real `ask_user` beside the test `echo` tool.
    const { turn } = turnTools({ store, registry: createTestToolRegistry() })
    await store.putToolSettings('user_a', {
      builtin: { [TEST_TOOL_NAME]: { enabled: false, policy: 'deny' } },
      mcp: {},
    })

    expect(await turn.toolSettings?.('user_a', null)).toEqual({
      [ASK_USER_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TOOL_NAME]: { enabled: false, permission: 'deny' },
    })
    // A user who has saved nothing gets each tool's own declaration: offered, and allowed.
    expect(await turn.toolSettings?.('user_b', null)).toEqual({
      [ASK_USER_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TOOL_NAME]: { enabled: true, permission: 'allow' },
    })
  })

  it('echoes its input back, and reads nothing else', async () => {
    const { turn } = turnTools({ kind: 'mock', maxToolSteps: 1 })

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
    const { turn } = turnTools({ search: { ...SEARCH, dailyLimit: 1 }, store })
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

  it('builds the built-ins and ask_user through createTurnRegistry, and the test registry on its own', () => {
    const built = createTurnRegistry({
      config: { search: null },
      kind: 'provider',
      searchTransport: createProviderFetch(),
    })
    expect(built.tools.map((tool) => tool.name)).toEqual([
      ASK_USER_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
    ])
    expect(createTestToolRegistry().tools.map((tool) => tool.name)).toEqual([
      ASK_USER_TOOL_NAME,
      TEST_TOOL_NAME,
    ])
  })

  it('registers an ask_user that declares a policy and never answers a call itself', async () => {
    const registry = createTurnRegistry({
      config: { search: null },
      kind: 'provider',
      searchTransport: createProviderFetch(),
    })
    const tool = registry.get(ASK_USER_TOOL_NAME)

    // `allow` is the declared policy (X7/X8: the pause is the tool's own, not a permission's),
    // and its `run` is the safety net for a call nothing should have run.
    expect(tool?.permission).toBe('allow')
    const result = await registry.execute(
      ASK_USER_TOOL_NAME,
      { questions: [{ question: 'Which?', header: 'Which', type: 'confirm' }] },
      {},
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toContain('answered by the user')
  })
})
