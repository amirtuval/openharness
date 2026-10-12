import { describe, expect, it } from 'vitest'

import { emptyRegistry } from './catalog/registry'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import { createTurnTools, TEST_TOOL_NAME, testEchoTool } from './tools'

/**
 * The tools this server runs with (epic #303, #304).
 *
 * The registry itself is `@openharness/hands`' and is tested there; what this file pins is the
 * server's half: which process gets a registry at all, and what the one test tool is.
 */

describe('createTurnTools', () => {
  it('registers the test tool for the mock model, and nothing for a provider model', () => {
    const config = { maxToolSteps: 50 }

    const mock = createTurnTools(config, 'mock', emptyRegistry)
    expect(mock?.tools.tools.map((tool) => tool.name)).toEqual([TEST_TOOL_NAME])
    expect(mock?.maxToolSteps).toBe(50)
    // The gate is wired to the registry, so a model that cannot call tools is not offered any.
    expect(mock?.toolSupportFor).toBeTypeOf('function')

    // A deployment on a real provider model has no tools at all — this build registers none
    // (the built-ins are #305), and that is a chat, not a degraded mode.
    expect(createTurnTools(config, 'provider', emptyRegistry)).toBeUndefined()
  })

  it('echoes its input back, and reads nothing else', async () => {
    const registry = createTurnTools({ maxToolSteps: 1 }, 'mock', emptyRegistry)

    const result = await registry?.tools.execute(TEST_TOOL_NAME, { text: 'ping' }, {})

    expect(result).toEqual({ content: [{ type: 'text', text: 'ping' }] })
    // An input the tool's own schema refuses is a result, not a throw: the model is told.
    expect(await registry?.tools.execute(TEST_TOOL_NAME, {}, undefined)).toMatchObject({
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
