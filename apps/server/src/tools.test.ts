import { describe, expect, it } from 'vitest'

import { InMemorySessionStore } from '@openharness/session'

import { emptyRegistry } from './catalog/registry'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import { ASK_USER_TOOL_NAME } from '@openharness/protocol'
import { createTurnRegistry, createTurnTools, TEST_TOOL_NAME, testEchoTool } from './tools'
import type { TurnToolDeps } from './tools'

/**
 * The tools this server runs with (epic #303, #304; the per-user settings: #307; `ask_user`:
 * #309).
 *
 * The registry itself is `@openharness/hands`' and is tested there; what this file pins is the
 * server's half: which tools a process registers — `ask_user` in every deployment, the test
 * tool under the mock model — and that the settings resolver the turn is handed reads the
 * session owner's stored choices.
 */

/** The deps a turn's tools are built from, with a store of its own. */
function deps(kind: 'mock' | 'provider'): TurnToolDeps {
  return {
    config: { maxToolSteps: 50 },
    tools: createTurnRegistry(kind),
    store: new InMemorySessionStore(),
    registry: emptyRegistry,
  }
}

describe('createTurnTools', () => {
  it('registers ask_user everywhere, and the test tool under the mock model', () => {
    const mock = createTurnTools(deps('mock'))
    expect(mock.tools.tools.map((tool) => tool.name)).toEqual([ASK_USER_TOOL_NAME, TEST_TOOL_NAME])
    expect(mock.maxToolSteps).toBe(50)
    // The gate is wired to the registry, so a model that cannot call tools is not offered any.
    expect(mock.toolSupportFor).toBeTypeOf('function')
    // And the settings resolver (#307) is wired to the store, so a user's choices are read.
    expect(mock.toolSettings).toBeTypeOf('function')

    // A deployment on a real provider model registers `ask_user` and nothing else: the built-ins
    // are #305, and a model that asks the user a question pauses whatever else is registered.
    expect(createTurnTools(deps('provider')).tools.tools.map((tool) => tool.name)).toEqual([
      ASK_USER_TOOL_NAME,
    ])
  })

  it('reads the owner’s stored choices through the resolver it wires (#307)', async () => {
    const store = new InMemorySessionStore()
    const built = createTurnTools({ ...deps('mock'), store })
    await store.putToolSettings('user_a', {
      builtin: { [TEST_TOOL_NAME]: { enabled: false, policy: 'deny' } },
    })

    expect(await built.toolSettings?.('user_a', null)).toEqual({
      [ASK_USER_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TOOL_NAME]: { enabled: false, permission: 'deny' },
    })
    // A user who has saved nothing gets each tool's own declaration: offered, and allowed.
    expect(await built.toolSettings?.('user_b', null)).toEqual({
      [ASK_USER_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TOOL_NAME]: { enabled: true, permission: 'allow' },
    })
  })

  it('echoes its input back, and reads nothing else', async () => {
    const registry = createTurnRegistry('mock')

    const result = await registry.execute(TEST_TOOL_NAME, { text: 'ping' }, {})

    expect(result).toEqual({ content: [{ type: 'text', text: 'ping' }] })
    // An input the tool's own schema refuses is a result, not a throw: the model is told.
    expect(await registry.execute(TEST_TOOL_NAME, {}, undefined)).toMatchObject({
      isError: true,
    })
  })

  it('does not depend on the mock env value happening to match', () => {
    // The kind comes from `resolveModelFactory`, which refuses any value but `mock`; this is
    // the string it refuses everything else against, and the one the docs name.
    expect(MOCK_MODEL_ENV_VALUE).toBe('mock')
    expect(testEchoTool.permission).toBe('allow')
  })

  it('registers an ask_user that declares a policy and never answers a call itself', async () => {
    const registry = createTurnRegistry('provider')
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
