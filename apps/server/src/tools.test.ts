import { describe, expect, it } from 'vitest'

import { InMemorySessionStore } from '@openharness/session'

import { emptyRegistry } from './catalog/registry'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import { createTurnRegistry, createTurnTools, TEST_TOOL_NAME, testEchoTool } from './tools'
import type { TurnToolDeps } from './tools'

/**
 * The tools this server runs with (epic #303, #304; the per-user settings: #307).
 *
 * The registry itself is `@openharness/hands`' and is tested there; what this file pins is the
 * server's half: which process gets a registry at all, what the one test tool is, and that the
 * settings resolver the turn is handed reads the session owner's stored choices.
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
  it('registers the test tool for the mock model, and nothing for a provider model', () => {
    const mock = createTurnTools(deps('mock'))
    expect(mock?.tools.tools.map((tool) => tool.name)).toEqual([TEST_TOOL_NAME])
    expect(mock?.maxToolSteps).toBe(50)
    // The gate is wired to the registry, so a model that cannot call tools is not offered any.
    expect(mock?.toolSupportFor).toBeTypeOf('function')
    // And the settings resolver (#307) is wired to the store, so a user's choices are read.
    expect(mock?.toolSettings).toBeTypeOf('function')

    // A deployment on a real provider model has no tools at all — this build registers none
    // (the built-ins are #305), and that is a chat, not a degraded mode.
    expect(createTurnTools(deps('provider'))).toBeUndefined()
  })

  it('reads the owner’s stored choices through the resolver it wires (#307)', async () => {
    const store = new InMemorySessionStore()
    const built = createTurnTools({ ...deps('mock'), store })
    await store.putToolSettings('user_a', {
      builtin: { [TEST_TOOL_NAME]: { enabled: false, policy: 'deny' } },
    })

    expect(await built?.toolSettings?.('user_a', null)).toEqual({
      [TEST_TOOL_NAME]: { enabled: false, permission: 'deny' },
    })
    // A user who has saved nothing gets the tool's own declaration: offered, and allowed.
    expect(await built?.toolSettings?.('user_b', null)).toEqual({
      [TEST_TOOL_NAME]: { enabled: true, permission: 'allow' },
    })
  })

  it('echoes its input back, and reads nothing else', async () => {
    const registry = createTurnRegistry('mock')

    const result = await registry?.execute(TEST_TOOL_NAME, { text: 'ping' }, {})

    expect(result).toEqual({ content: [{ type: 'text', text: 'ping' }] })
    // An input the tool's own schema refuses is a result, not a throw: the model is told.
    expect(await registry?.execute(TEST_TOOL_NAME, {}, undefined)).toMatchObject({
      isError: true,
    })
  })

  it('does not depend on the mock env value happening to match', () => {
    // The kind comes from `resolveModelFactory`, which refuses any value but `mock`; this is
    // the string it refuses everything else against, and the one the docs name.
    expect(MOCK_MODEL_ENV_VALUE).toBe('mock')
    expect(testEchoTool.permission).toBe('allow')
  })
})
