import { WEB_FETCH_TOOL_NAME } from '@openharness/hands'
import type { ToolRegistry } from '@openharness/hands'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '@openharness/protocol'
import { InMemorySessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { emptyRegistry } from './catalog/registry'
import { TEST_TASK_TOOL_NAME } from './test-tasks'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import {
  createTestToolRegistry,
  createTurnRegistry,
  createTurnTools,
  TEST_SLOW_TOOL_NAME,
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
 * every process, the test `echo` tool under the mock model — and that the settings resolver the
 * turn is handed reads the session owner's stored choices.
 *
 * `web_search` is deliberately **not** one of them (#335): it is a provider's own tool, attached
 * to a request by the brain, and what a user chooses about it is a settings entry rather than a
 * registration. The settings half of it — the listing, the model-dependent availability and the
 * refused `ask` — is `tool-settings.test.ts`.
 */

/** The tools a turn is handed, as `main.ts` builds them. */
function turnTools(
  options: {
    readonly kind?: TurnToolsOptions['kind']
    readonly maxToolSteps?: number
    readonly store?: InMemorySessionStore
    /** A registry of the test's own, instead of the built-ins the process would register. */
    readonly registry?: ToolRegistry
  } = {},
): { names: string[]; turn: ReturnType<typeof createTurnTools>; store: InMemorySessionStore } {
  const store = options.store ?? new InMemorySessionStore()
  const turn = createTurnTools({
    config: {
      maxToolSteps: options.maxToolSteps ?? 50,
      maxAgentDepth: 3,
      maxLiveTasks: 10,
    },
    kind: options.kind ?? 'provider',
    ...(options.registry === undefined ? {} : { tools: options.registry }),
    store,
    registry: emptyRegistry,
  })
  return { names: turn.tools.tools.map((tool) => tool.name), turn, store }
}

describe('createTurnRegistry and createTurnTools', () => {
  it('offers the built-ins, ask_user and the subagent tools to every deployment', () => {
    const { names, turn } = turnTools({})
    // The five of #344 sit between `ask_user` and the built-ins: a deployment offers them
    // unless its owner turns one off, and a host that wires no subagent resolver still lists
    // them (the loop is what withholds them from a session).
    expect(names).toEqual([
      ASK_USER_TOOL_NAME,
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
      MESSAGE_PARENT_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
    ])
    expect(turn.maxToolSteps).toBe(50)
    // The gate is wired to the registry, so a model that cannot call tools is offered none.
    expect(turn.toolSupportFor).toBeTypeOf('function')
    // And the settings resolver (#307) is wired to the store, so a user's choices are read.
    expect(turn.toolSettings).toBeTypeOf('function')
    // Nothing reaches a secret a deployment did not configure.
    expect(turn.resolveToolSecrets).toBeUndefined()
  })

  it('adds the test tools for the mock model, after ask_user and ahead of the built-ins', () => {
    // The `echo` tool and — since #343 — the task the mock model can start. They ride with the
    // mock model rather than with a deployment; the wait a chat ends a turn on is #344's, and is
    // registered for everybody.
    expect(turnTools({ kind: 'mock' }).names).toEqual([
      ASK_USER_TOOL_NAME,
      TEST_TOOL_NAME,
      TEST_TASK_TOOL_NAME,
      TEST_SLOW_TOOL_NAME,
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
      MESSAGE_PARENT_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
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

    // `web_search` is in the answer too, without being in the registry: it is a provider's own
    // tool, and the settings are where a user's choice about it lives (#335). It follows its
    // declaration — `allow`, offered — for a user who has chosen nothing.
    expect(await turn.toolSettings?.('user_a', null)).toEqual({
      [ASK_USER_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TOOL_NAME]: { enabled: false, permission: 'deny' },
      [TEST_TASK_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [WEB_SEARCH_TOOL_NAME]: { enabled: true, permission: 'allow' },
    })
    // A user who has saved nothing gets each tool's own declaration: offered, and allowed.
    expect(await turn.toolSettings?.('user_b', null)).toEqual({
      [ASK_USER_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [TEST_TASK_TOOL_NAME]: { enabled: true, permission: 'allow' },
      [WEB_SEARCH_TOOL_NAME]: { enabled: true, permission: 'allow' },
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

  it('does not depend on the mock env value happening to match', () => {
    // The kind comes from `resolveModelFactory`, which refuses any value but `mock`; this is
    // the string it refuses everything else against, and the one the docs name.
    expect(MOCK_MODEL_ENV_VALUE).toBe('mock')
    expect(testEchoTool.permission).toBe('allow')
  })

  it('builds the built-ins and ask_user through createTurnRegistry, and the test registry on its own', () => {
    const built = createTurnRegistry({ kind: 'provider' })
    expect(built.tools.map((tool) => tool.name)).toEqual([
      ASK_USER_TOOL_NAME,
      // The subagent tools every deployment registers (epic #340, S5; #344), ahead of the
      // built-ins: a chat is offered them unless its owner turns one off.
      AGENT_TOOL_NAME,
      AGENT_MESSAGE_TOOL_NAME,
      TASK_WAIT_TOOL_NAME,
      AGENT_STOP_TOOL_NAME,
      MESSAGE_PARENT_TOOL_NAME,
      WEB_FETCH_TOOL_NAME,
      'todo_write',
    ])
    expect(createTestToolRegistry().tools.map((tool) => tool.name)).toEqual([
      ASK_USER_TOOL_NAME,
      TEST_TOOL_NAME,
      TEST_TASK_TOOL_NAME,
    ])
  })

  it('registers an ask_user that declares a policy and never answers a call itself', async () => {
    const registry = createTurnRegistry({ kind: 'provider' })
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
