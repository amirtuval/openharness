import {
  GENERAL_PURPOSE_DESCRIPTION,
  GENERAL_PURPOSE_TYPE,
  type SubagentParent,
  type SubagentTypeResolution,
  type SubagentTypeResolver,
} from '@openharness/brain'
import { WEB_FETCH_TOOL_NAME } from '@openharness/hands'
import type { ToolRegistry } from '@openharness/hands'
import {
  API_VERSION_PREFIX,
  ASK_USER_TOOL_NAME,
  ModeSchema,
  TODO_WRITE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type Mode,
  type ModeToolOverride,
  type UserId,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { createSubagentTypeResolver } from './subagent-types'
import { createTurnRegistry } from './tools'
import { createTestApp, postJson, postJsonAs, type TestContext } from './test-support'

/**
 * Subagent types (epic #340, decision S2; issue #342), over the real routes and the real
 * stores.
 *
 * A type is a **mode with a description**, so both halves are exercised here: the round trip of
 * `subagent_description` through `/v1/me/modes` — which is what makes a mode a type at all — and
 * the resolver the parent's `agent` tool (#344) asks: what types exist, and what one of them
 * starts.
 *
 * The resolver is called directly rather than through a route, because no route serves it yet:
 * it is the seam #344's tool closes over, built here exactly as `main.ts` would build it.
 * Everything it reads is real — the in-memory store the app runs on, the credential rows saved
 * through the credential route, this process's own tool registry — so what these tests assert
 * is what a chat with a parent would get.
 */

const MODES = `${API_VERSION_PREFIX}/me/modes`
const CREDENTIALS = `${API_VERSION_PREFIX}/provider-credentials`
const PREFERENCES = `${API_VERSION_PREFIX}/me/preferences`

/** The tools a deployment registers, for the tests that read the resolved tool set. */
const TURN_TOOLS = createTurnRegistry({ kind: 'provider' })

/** What the parent chat looks like when the tool asks: this request's model, effort and mode. */
const PARENT: SubagentParent = {
  model: 'anthropic/claude-sonnet-5',
  reasoningEffort: 'medium',
  toolOverride: null,
  modeId: null,
}

/** The id of the caller the harness's requests are made as. */
async function callerOf(test: TestContext): Promise<UserId> {
  return (await test.currentUser()).id
}

/** A credential for `provider`, saved through the real route (the default validator accepts). */
async function putKey(test: TestContext, provider: string): Promise<void> {
  const response = await test.request(`${CREDENTIALS}/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'api_key', api_key: `sk-test-${provider}-0123456789` }),
  })
  expect(response.status).toBe(200)
}

/** Set the caller's default model through the route. */
async function putDefaultModel(test: TestContext, model: string): Promise<void> {
  const response = await test.request(PREFERENCES, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ default_model: model }),
  })
  expect(response.status).toBe(200)
}

/** Create a mode through the route and return it. */
async function createMode(test: TestContext, body: unknown): Promise<Mode> {
  const response = await postJson(test, MODES, body)
  expect(response.status).toBe(201)
  return ModeSchema.parse(await response.json())
}

/** Read one mode through the route. */
async function readMode(test: TestContext, modeId: string): Promise<Mode> {
  const response = await test.request(`${MODES}/${modeId}`)
  expect(response.status).toBe(200)
  return ModeSchema.parse(await response.json())
}

/**
 * The resolver as the server would build it: over the app's own store and credential store, and
 * the tools this process registers.
 */
function resolver(test: TestContext): SubagentTypeResolver {
  return makeResolver(test, TURN_TOOLS)
}

/** The same, for a deployment that registers no tools at all. */
function resolverWithoutTools(test: TestContext): SubagentTypeResolver {
  return makeResolver(test, undefined)
}

function makeResolver(test: TestContext, tools: ToolRegistry | undefined): SubagentTypeResolver {
  return createSubagentTypeResolver({
    store: test.store,
    credentials: test.credentials,
    tools,
  })
}

/** The message of a refusal, asserting the resolution really was one. */
function refusal(resolution: SubagentTypeResolution): string {
  expect(resolution.ok).toBe(false)
  return resolution.ok ? '' : resolution.message
}

describe('a mode’s subagent description over the routes (#342)', () => {
  it('round-trips a description on create, read and list, and defaults to null', async () => {
    const test = createTestApp()
    const description = 'Reviews a diff for correctness bugs and reports what it found.'
    const reviewer = await createMode(test, {
      name: 'reviewer',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: description,
    })
    expect(reviewer.subagent_description).toBe(description)
    expect((await readMode(test, reviewer.id)).subagent_description).toBe(description)

    const plain = await createMode(test, { name: 'plain', model: 'openai/gpt-4.1-mini' })
    expect(plain.subagent_description).toBeNull()
    const listed = (await (await test.request(MODES)).json()) as { data: Mode[] }
    expect(listed.data.map((mode) => mode.subagent_description)).toEqual([description, null])
  })

  it('sets a description on update, clears it with null, and keeps it when omitted', async () => {
    const test = createTestApp()
    const mode = await createMode(test, {
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'The first description.',
    })
    const renamed = ModeSchema.parse(
      await (await postJson(test, `${MODES}/${mode.id}`, { name: 'deeper' })).json(),
    )
    expect(renamed.subagent_description).toBe('The first description.')

    const set = ModeSchema.parse(
      await (
        await postJson(test, `${MODES}/${mode.id}`, {
          subagent_description: 'Searches the web and reports sources.',
        })
      ).json(),
    )
    expect(set.subagent_description).toBe('Searches the web and reports sources.')
    expect(
      ModeSchema.parse(
        await (await postJson(test, `${MODES}/${mode.id}`, { subagent_description: null })).json(),
      ).subagent_description,
    ).toBeNull()
  })

  it('refuses an empty one and one longer than the cap, storing nothing', async () => {
    const test = createTestApp()
    for (const subagent_description of ['', 'x'.repeat(501)]) {
      const created = await postJson(test, MODES, {
        name: 'bad',
        model: 'anthropic/claude-sonnet-5',
        subagent_description,
      })
      expect(created.status, `create with a ${subagent_description.length}-character one`).toBe(400)
      expect(((await (await test.request(MODES)).json()) as { data: Mode[] }).data).toEqual([])
    }
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const updated = await postJson(test, `${MODES}/${mode.id}`, { subagent_description: '' })
    expect(updated.status).toBe(400)
    expect((await readMode(test, mode.id)).subagent_description).toBeNull()
  })
})

describe('the subagent type list (#342)', () => {
  it('offers general-purpose first, then the described modes oldest first', async () => {
    const test = createTestApp()
    const reviewer = await createMode(test, {
      name: 'reviewer',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'Reviews a diff for correctness bugs.',
    })
    const searcher = await createMode(test, {
      name: 'searcher',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'Searches the web and reports sources.',
    })
    expect(await resolver(test).list(await callerOf(test))).toEqual([
      { name: GENERAL_PURPOSE_TYPE, description: GENERAL_PURPOSE_DESCRIPTION },
      { name: 'reviewer', description: reviewer.subagent_description },
      { name: 'searcher', description: searcher.subagent_description },
    ])
  })

  it('leaves out a mode with no description, and never lists another user’s modes', async () => {
    const test = createTestApp()
    await createMode(test, {
      name: 'reviewer',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'Reviews a diff.',
    })
    await createMode(test, { name: 'plain', model: 'openai/gpt-4.1-mini' })

    // A second user, with a described mode of their own: their resource is theirs alone.
    const other = await test.signIn('someone-else@example.com')
    const theirs = await postJsonAs(test, other.token, MODES, {
      name: 'secret',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'Another user’s type.',
    })
    expect(theirs.status).toBe(201)

    const mine = await resolver(test).list(await callerOf(test))
    expect(mine.map((type) => type.name)).toEqual([GENERAL_PURPOSE_TYPE, 'reviewer'])
    const asThem = await resolver(test).list(other.user.id)
    expect(asThem.map((type) => type.name)).toEqual([GENERAL_PURPOSE_TYPE, 'secret'])
  })

  it('offers only general-purpose to a deployment with no tools, and resolves it to none', async () => {
    const test = createTestApp()
    const bare = resolverWithoutTools(test)
    const caller = await callerOf(test)
    expect((await bare.list(caller)).map((type) => type.name)).toEqual([GENERAL_PURPOSE_TYPE])
    const resolution = await bare.resolve(caller, GENERAL_PURPOSE_TYPE, PARENT)
    expect(resolution.ok && resolution.type.tools).toEqual([])
    expect(resolution.ok && resolution.type.mcpServers).toEqual([])
  })
})

describe('resolving a subagent type (#342)', () => {
  it('resolves general-purpose to the parent’s own model, effort and tools', async () => {
    const test = createTestApp()
    await putKey(test, 'anthropic')
    const resolution = await resolver(test).resolve(
      await callerOf(test),
      GENERAL_PURPOSE_TYPE,
      PARENT,
    )
    expect(resolution).toEqual({
      ok: true,
      type: {
        name: GENERAL_PURPOSE_TYPE,
        description: GENERAL_PURPOSE_DESCRIPTION,
        model: PARENT.model,
        reasoningEffort: PARENT.reasoningEffort,
        systemPromptAddition: null,
        toolOverride: null,
        // This process's built-ins in the registry's order, with the provider-native
        // `web_search` the settings list beside them (#335). `ask_user` is among them because
        // this is the type's tool set as a chat resolves it: a *child* is never offered it
        // (epic #340, S1), which the loop applies from the session's own `interactive` flag —
        // the child is created with it off, and this resolver does not decide it.
        tools: [
          ASK_USER_TOOL_NAME,
          WEB_FETCH_TOOL_NAME,
          TODO_WRITE_TOOL_NAME,
          WEB_SEARCH_TOOL_NAME,
        ],
        mcpServers: [],
      },
    })
  })

  it('carries the parent’s mode override through general-purpose, applied', async () => {
    const test = createTestApp()
    const toolOverride: ModeToolOverride = {
      builtin: { [WEB_FETCH_TOOL_NAME]: false },
      mcp_servers: {},
    }
    const resolution = await resolver(test).resolve(await callerOf(test), GENERAL_PURPOSE_TYPE, {
      ...PARENT,
      toolOverride,
    })
    expect(resolution.ok && resolution.type.toolOverride).toEqual(toolOverride)
    // The override is a patch over the owner's settings — the same answer the loop computes for
    // the parent's own request — so the tool it turned off is absent and the rest are there.
    expect(resolution.ok && resolution.type.tools).toEqual([
      ASK_USER_TOOL_NAME,
      TODO_WRITE_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
    ])
  })

  it('resolves a mode type to exactly what a chat on that mode runs', async () => {
    const test = createTestApp()
    await putKey(test, 'anthropic')
    const mode = await createMode(test, {
      name: 'reviewer',
      model: 'anthropic/claude-sonnet-5',
      reasoning_effort: 'high',
      system_prompt_addition: 'Be terse.',
      subagent_description: 'Reviews a diff.',
      tools: { builtin: { [TODO_WRITE_TOOL_NAME]: false } },
    })
    expect(await resolver(test).resolve(await callerOf(test), 'reviewer', PARENT)).toEqual({
      ok: true,
      type: {
        name: 'reviewer',
        description: mode.subagent_description,
        model: 'anthropic/claude-sonnet-5',
        reasoningEffort: 'high',
        systemPromptAddition: 'Be terse.',
        toolOverride: mode.tools,
        tools: [ASK_USER_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME],
        mcpServers: [],
      },
    })
  })

  it('resolves “my default model” to the owner’s stored default', async () => {
    const test = createTestApp()
    await putKey(test, 'openai')
    await putDefaultModel(test, 'openai/gpt-4.1-mini')
    await createMode(test, {
      name: 'mine',
      model: 'my-default-model',
      subagent_description: 'Runs on my default model.',
    })
    const resolution = await resolver(test).resolve(await callerOf(test), 'mine', PARENT)
    expect(resolution.ok && resolution.type.model).toBe('openai/gpt-4.1-mini')
  })

  it('answers an unknown name with the types that are available', async () => {
    const test = createTestApp()
    await createMode(test, {
      name: 'reviewer',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'Reviews a diff.',
    })
    const message = refusal(await resolver(test).resolve(await callerOf(test), 'nope', PARENT))
    expect(message).toContain('"nope"')
    expect(message).toContain(GENERAL_PURPOSE_TYPE)
    expect(message).toContain('reviewer')
  })

  it('treats a mode with no description, and another user’s mode, as no such type', async () => {
    const test = createTestApp()
    await createMode(test, { name: 'plain', model: 'openai/gpt-4.1-mini' })
    const caller = await callerOf(test)
    expect(refusal(await resolver(test).resolve(caller, 'plain', PARENT))).toContain('"plain"')
    expect((await resolver(test).list(caller)).map((type) => type.name)).toEqual([
      GENERAL_PURPOSE_TYPE,
    ])

    const other = await test.signIn('someone-else@example.com')
    const theirs = await postJsonAs(test, other.token, MODES, {
      name: 'secret',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'Another user’s type.',
    })
    expect(theirs.status).toBe(201)
    expect(refusal(await resolver(test).resolve(caller, 'secret', PARENT))).toContain('"secret"')
  })

  it('refuses a mode whose model cannot be used, naming the type and what to do', async () => {
    const test = createTestApp()
    const caller = await callerOf(test)
    await putKey(test, 'anthropic')
    // No credential for the provider the mode names: the mode is stored, and not startable.
    const unkeyed = await createMode(test, {
      name: 'openai-helper',
      model: 'openai/gpt-4.1-mini',
      subagent_description: 'Runs on OpenAI.',
    })
    const message = refusal(await resolver(test).resolve(caller, 'openai-helper', PARENT))
    expect(message).toContain('"openai-helper"')
    expect(message).toContain('not available')
    expect(message).toContain('different type')
    // It is still listed: the list is what the model chooses from, and the choice is refused.
    expect((await resolver(test).list(caller)).map((type) => type.name)).toContain(unkeyed.name)

    // "My default model" with no default set is the same refusal, through the same rule.
    await createMode(test, {
      name: 'mine',
      model: 'my-default-model',
      subagent_description: 'Runs on my default model.',
    })
    expect(refusal(await resolver(test).resolve(caller, 'mine', PARENT))).toContain('"mine"')
  })

  it('applies an edit made between two starts to the second', async () => {
    const test = createTestApp()
    await putKey(test, 'anthropic')
    // The edit moves the mode onto another provider, so that provider is usable too: this test
    // is about the edit being followed, not about availability.
    await putKey(test, 'openai')
    const mode = await createMode(test, {
      name: 'helper',
      model: 'anthropic/claude-sonnet-5',
      subagent_description: 'First description.',
    })
    const caller = await callerOf(test)
    const first = await resolver(test).resolve(caller, 'helper', PARENT)
    expect(first.ok && first.type).toMatchObject({
      name: 'helper',
      description: 'First description.',
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: null,
    })

    const updated = await postJson(test, `${MODES}/${mode.id}`, {
      name: 'helper-renamed',
      model: 'openai/gpt-4.1-mini',
      reasoning_effort: 'low',
      subagent_description: 'Second description.',
      tools: { builtin: { [WEB_FETCH_TOOL_NAME]: false } },
    })
    expect(updated.status).toBe(200)

    // A type is a mode resolved as it is now: the rename moves the lookup, and the second start
    // runs the edited model, effort, description and tool set.
    expect(refusal(await resolver(test).resolve(caller, 'helper', PARENT))).toContain('"helper"')
    const second = await resolver(test).resolve(caller, 'helper-renamed', PARENT)
    expect(second.ok && second.type).toMatchObject({
      name: 'helper-renamed',
      description: 'Second description.',
      model: 'openai/gpt-4.1-mini',
      reasoningEffort: 'low',
      tools: [ASK_USER_TOOL_NAME, TODO_WRITE_TOOL_NAME, WEB_SEARCH_TOOL_NAME],
    })
  })
})
