import { describe, expect, it } from 'vitest'

import { makeSkill } from '../fixtures'
import { newMcpServerId, newModeId, newSkillId } from '../ids'
import {
  CreateModeRequestSchema,
  ListModesResponseSchema,
  MAX_MODES_PER_USER,
  MODE_DEFAULT_MODEL,
  MODE_ITEM_DEFAULT,
  MODE_NAME_MAX_LENGTH,
  MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH,
  ModeItemDefaultSchema,
  ModeModelSchema,
  ModeReferenceSchema,
  ModeSchema,
  ModeToolOverrideSchema,
  UpdateModeRequestSchema,
  builtinToolInForce,
  mcpServerInForce,
  modeItemInForce,
} from './mode'
import { skillInForce } from './skill'

const mode = {
  id: newModeId(),
  type: 'mode',
  owner_id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS',
  name: 'deep',
  model: 'anthropic/claude-sonnet-5',
  reasoning_effort: 'high',
  system_prompt_addition: 'Think step by step.',
  subagent_description: null,
  tools: null,
  created_at: '2026-03-15T10:00:00Z',
  updated_at: '2026-03-15T10:00:00Z',
}

describe('ModeSchema', () => {
  it('parses a mode', () => {
    expect(ModeSchema.parse(mode)).toEqual(mode)
  })

  it('accepts "my default model" as the model, and null effort and addition', () => {
    expect(
      ModeSchema.parse({
        ...mode,
        model: MODE_DEFAULT_MODEL,
        reasoning_effort: null,
        system_prompt_addition: null,
      }),
    ).toMatchObject({
      model: MODE_DEFAULT_MODEL,
      reasoning_effort: null,
      system_prompt_addition: null,
    })
  })

  it('requires the owner the server assigned, and accepts nothing else as one', () => {
    const { owner_id: _owner, ...withoutOwner } = mode
    expect(ModeSchema.safeParse(withoutOwner).success).toBe(false)
    expect(ModeSchema.safeParse({ ...mode, owner_id: '' }).success).toBe(false)
    expect(ModeSchema.safeParse({ ...mode, owner_id: 7 }).success).toBe(false)
  })

  it('rejects a bad id, an empty name and a missing timestamp', () => {
    expect(ModeSchema.safeParse({ ...mode, id: 'mode_nope' }).success).toBe(false)
    expect(
      ModeSchema.safeParse({ ...mode, id: newModeId().replace('mode_', 'sesn_') }).success,
    ).toBe(false)
    expect(ModeSchema.safeParse({ ...mode, name: '' }).success).toBe(false)
    expect(
      ModeSchema.safeParse({ ...mode, name: 'x'.repeat(MODE_NAME_MAX_LENGTH + 1) }).success,
    ).toBe(false)
    const { updated_at: _updated, ...withoutUpdatedAt } = mode
    expect(ModeSchema.safeParse(withoutUpdatedAt).success).toBe(false)
  })
})

describe('ModeModelSchema', () => {
  it('accepts a `provider/model` id and the default-model sentinel', () => {
    expect(ModeModelSchema.parse('anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
    expect(ModeModelSchema.parse('openrouter/meta-llama/llama-3.3-70b')).toBe(
      'openrouter/meta-llama/llama-3.3-70b',
    )
    expect(ModeModelSchema.parse(MODE_DEFAULT_MODEL)).toBe(MODE_DEFAULT_MODEL)
  })

  it('rejects a bare model name, an empty string and whitespace', () => {
    expect(ModeModelSchema.safeParse('claude-sonnet-5').success).toBe(false)
    expect(ModeModelSchema.safeParse('').success).toBe(false)
    expect(ModeModelSchema.safeParse('anthropic /claude-sonnet-5').success).toBe(false)
    expect(ModeModelSchema.safeParse('anthropic/').success).toBe(false)
  })
})

describe('ModeReferenceSchema', () => {
  it('carries the id a request ran under and the name it had then', () => {
    expect(ModeReferenceSchema.parse({ id: mode.id, name: mode.name })).toEqual({
      id: mode.id,
      name: mode.name,
    })
    expect(ModeReferenceSchema.safeParse({ id: mode.id, name: '' }).success).toBe(false)
    expect(ModeReferenceSchema.safeParse({ id: mode.id }).success).toBe(false)
  })
})

describe('mode request schemas', () => {
  it('accepts a minimal create body', () => {
    expect(CreateModeRequestSchema.parse({ name: 'fast', model: 'openai/gpt-4.1-mini' })).toEqual({
      name: 'fast',
      model: 'openai/gpt-4.1-mini',
    })
  })

  it('accepts the default-model sentinel and the optional fields on create', () => {
    expect(
      CreateModeRequestSchema.parse({
        name: 'mine',
        model: MODE_DEFAULT_MODEL,
        reasoning_effort: 'low',
        system_prompt_addition: 'Be terse.',
      }),
    ).toEqual({
      name: 'mine',
      model: MODE_DEFAULT_MODEL,
      reasoning_effort: 'low',
      system_prompt_addition: 'Be terse.',
    })
  })

  it('carries the subagent description a mode may set (#342)', () => {
    const description = 'Reviews a diff for correctness bugs and reports what it found.'
    expect(
      ModeSchema.parse({ ...mode, subagent_description: description }).subagent_description,
    ).toBe(description)
    expect(
      CreateModeRequestSchema.parse({
        name: 'reviewer',
        model: 'x/y',
        subagent_description: description,
      }),
    ).toEqual({ name: 'reviewer', model: 'x/y', subagent_description: description })
    expect(UpdateModeRequestSchema.parse({ subagent_description: description })).toEqual({
      subagent_description: description,
    })
    // `null` is a mode that is not a subagent type, which is what a mode without the field is.
    expect(UpdateModeRequestSchema.parse({ subagent_description: null })).toEqual({
      subagent_description: null,
    })
    expect(
      ModeSchema.parse({ ...mode, subagent_description: null }).subagent_description,
    ).toBeNull()
  })

  it('refuses a subagent description that is empty or longer than the cap', () => {
    expect(ModeSchema.safeParse({ ...mode, subagent_description: '' }).success).toBe(false)
    expect(
      CreateModeRequestSchema.safeParse({ name: 'A', model: 'x/y', subagent_description: '' })
        .success,
    ).toBe(false)
    expect(UpdateModeRequestSchema.safeParse({ subagent_description: '' }).success).toBe(false)
    expect(
      ModeSchema.safeParse({
        ...mode,
        subagent_description: 'x'.repeat(MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH),
      }).success,
    ).toBe(true)
    expect(
      ModeSchema.safeParse({
        ...mode,
        subagent_description: 'x'.repeat(MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false)
    expect(MODE_SUBAGENT_DESCRIPTION_MAX_LENGTH).toBe(500)
  })

  it('carries the tool override a mode may set (#307)', () => {
    const tools = { builtin: { web_search: true, todo_write: false } }
    expect(ModeToolOverrideSchema.parse(tools)).toEqual(tools)
    expect(CreateModeRequestSchema.parse({ name: 'deep', model: 'x/y', tools })).toMatchObject({
      tools,
    })
    expect(UpdateModeRequestSchema.parse({ tools })).toEqual({ tools })
    // `null` is a mode that says nothing about tools, which is what a mode without the field is.
    expect(UpdateModeRequestSchema.parse({ tools: null })).toEqual({ tools: null })
    expect(ModeSchema.parse({ ...mode, tools }).tools).toEqual(tools)
  })

  it('refuses a tool name that is not a name, and an override that is not a map of booleans', () => {
    expect(ModeToolOverrideSchema.safeParse({ builtin: { '': true } }).success).toBe(false)
    expect(ModeToolOverrideSchema.safeParse({ builtin: { web_search: 'yes' } }).success).toBe(false)
    expect(ModeToolOverrideSchema.safeParse({ builtin: { web_search: {} } }).success).toBe(false)
    expect(ModeToolOverrideSchema.safeParse({ builtin: [] }).success).toBe(false)
  })

  it('carries the MCP-server half of the override, a sibling of `builtin` (#311)', () => {
    const server = newMcpServerId()
    const other = newMcpServerId()
    const override = {
      builtin: { web_search: true },
      mcp_servers: { [server]: true, [other]: false },
    }
    expect(ModeToolOverrideSchema.parse(override)).toEqual(override)
    // Both halves are optional in a mode's own terms — `builtin` empty, `mcp_servers` absent —
    // so a mode may override only the servers.
    expect(ModeToolOverrideSchema.parse({ builtin: {}, mcp_servers: { [server]: false } })).toEqual(
      { builtin: {}, mcp_servers: { [server]: false } },
    )
    expect(CreateModeRequestSchema.parse({ name: 'deep', model: 'x/y', tools: override })).toEqual({
      name: 'deep',
      model: 'x/y',
      tools: override,
    })
    expect(ModeSchema.parse({ ...mode, tools: override }).tools).toEqual(override)
  })

  it('carries the skills half of the override, a third sibling of `builtin` (#349, K8)', () => {
    const skill = newSkillId()
    const gone = newSkillId()
    const override = {
      builtin: { web_search: true },
      skills: { [skill]: false, [gone]: true },
    }
    expect(ModeToolOverrideSchema.parse(override)).toEqual(override)
    // A mode may override only the skills: a map naming a skill the user no longer has is
    // stored as given, which is what leaves a deleted skill's modes alone.
    expect(ModeToolOverrideSchema.parse({ builtin: {}, skills: { [gone]: true } })).toEqual({
      builtin: {},
      skills: { [gone]: true },
    })
    expect(ModeSchema.parse({ ...mode, tools: override }).tools).toEqual(override)
  })

  it('carries the three section defaults, and absent means follow (B8)', () => {
    // A default is an optional member of the same `tools` object, so a mode that carries only
    // one is exactly that — the other two read as `follow` and the writer's shape is kept.
    expect(ModeItemDefaultSchema.options).toEqual(['follow', 'off', 'on'])
    expect(MODE_ITEM_DEFAULT).toBe('follow')
    expect(ModeToolOverrideSchema.parse({ skills_default: 'off' })).toEqual({
      skills_default: 'off',
    })
    expect(ModeToolOverrideSchema.parse({ builtin_default: 'on' })).toEqual({
      builtin_default: 'on',
    })
    expect(
      ModeToolOverrideSchema.parse({
        mcp_servers_default: 'off',
        skills_default: 'on',
      }),
    ).toEqual({ mcp_servers_default: 'off', skills_default: 'on' })
    // A value outside the three is refused, and the field does not invent a key that is absent.
    expect(ModeToolOverrideSchema.safeParse({ skills_default: 'yes' }).success).toBe(false)
    expect(ModeToolOverrideSchema.safeParse({ builtin_default: true }).success).toBe(false)
    const created = CreateModeRequestSchema.parse({
      name: 'only',
      model: 'x/y',
      tools: { skills_default: 'off' },
    })
    expect(created.tools).toEqual({ skills_default: 'off' })
    expect(ModeSchema.parse({ ...mode, tools: { skills_default: 'off' } }).tools).toEqual({
      skills_default: 'off',
    })
  })

  it('resolves one item by entry × default × user setting (B8)', () => {
    // Every combination of the three things that decide one item: the map's entry (or none),
    // the section default (or its absence) and the user's own setting. The table is the rule
    // every consumer reads, so it is tested as one.
    const cases: readonly {
      readonly entry: boolean | undefined
      readonly follows: boolean
      readonly fallback: 'follow' | 'off' | 'on' | undefined
      readonly expected: boolean
    }[] = [
      // An explicit entry always wins, whatever the default and the user's setting.
      { entry: true, follows: false, fallback: 'off', expected: true },
      { entry: false, follows: true, fallback: 'on', expected: false },
      { entry: true, follows: false, fallback: undefined, expected: true },
      { entry: false, follows: true, fallback: undefined, expected: false },
      // No entry, `follow` (or absent): the user's own setting.
      { entry: undefined, follows: true, fallback: 'follow', expected: true },
      { entry: undefined, follows: false, fallback: 'follow', expected: false },
      { entry: undefined, follows: true, fallback: undefined, expected: true },
      { entry: undefined, follows: false, fallback: undefined, expected: false },
      // Off is an allowlist: an unlisted item is off, even one the user turned on.
      { entry: undefined, follows: true, fallback: 'off', expected: false },
      { entry: undefined, follows: false, fallback: 'off', expected: false },
      // On turns every unlisted item on, even one the user turned off.
      { entry: undefined, follows: true, fallback: 'on', expected: true },
      { entry: undefined, follows: false, fallback: 'on', expected: true },
    ]
    for (const testCase of cases) {
      expect(
        modeItemInForce(testCase.entry, testCase.follows, testCase.fallback),
        JSON.stringify(testCase),
      ).toBe(testCase.expected)
    }
  })

  it('resolves a built-in tool, an MCP server and a skill through the same rule (B8)', () => {
    const server = newMcpServerId()
    const skill = makeSkill({ id: newSkillId(), enabled: false })
    const override = {
      builtin: { web_search: false },
      mcp_servers: { [server]: false },
      skills: { [skill.id]: false },
      builtin_default: 'on',
      mcp_servers_default: 'on',
      skills_default: 'on',
    } as const
    // An entry wins over the `on` default.
    expect(builtinToolInForce('web_search', true, override)).toBe(false)
    expect(mcpServerInForce(server, true, override)).toBe(false)
    expect(skillInForce(skill, override)).toBe(false)
    // An unlisted item is on even though the user's own setting is off.
    expect(builtinToolInForce('todo_write', false, override)).toBe(true)
    expect(mcpServerInForce(newMcpServerId(), false, override)).toBe(true)
    expect(skillInForce(makeSkill({ id: newSkillId(), enabled: false }), override)).toBe(true)
    // A mode with no override at all is the user's own settings, in all three.
    expect(builtinToolInForce('todo_write', false, null)).toBe(false)
    expect(mcpServerInForce(server, false, null)).toBe(false)
    expect(skillInForce(skill, null)).toBe(false)
    // An absent default is `follow`, not `off`: every mode stored before B8 keeps its answer.
    expect(builtinToolInForce('todo_write', true, { builtin: {} })).toBe(true)
    expect(mcpServerInForce(server, true, { mcp_servers: {} })).toBe(true)
    expect(skillInForce(makeSkill({ id: newSkillId(), enabled: true }), { skills: {} })).toBe(true)
  })

  it('refuses a skill map whose key is not a skill id', () => {
    expect(ModeToolOverrideSchema.safeParse({ builtin: {}, skills: { deep: true } }).success).toBe(
      false,
    )
    expect(
      ModeToolOverrideSchema.safeParse({ builtin: {}, skills: { [newSkillId()]: 'on' } }).success,
    ).toBe(false)
  })

  it('treats a missing `mcp_servers` map as a mode that says nothing about servers', () => {
    // Every mode stored before #311 has this shape, so it has to keep parsing — and parsing it
    // must not invent a key the writer did not write.
    const parsed = ModeToolOverrideSchema.parse({ builtin: { web_fetch: false } })
    expect(parsed).toEqual({ builtin: { web_fetch: false } })
    expect(parsed).not.toHaveProperty('mcp_servers')
  })

  it('refuses an MCP server key that is not an `mcps_` id', () => {
    expect(
      ModeToolOverrideSchema.safeParse({ builtin: {}, mcp_servers: { notes: true } }).success,
    ).toBe(false)
    expect(
      ModeToolOverrideSchema.safeParse({
        builtin: {},
        mcp_servers: { [newMcpServerId().replace('mcps_', 'mode_')]: true },
      }).success,
    ).toBe(false)
    expect(
      ModeToolOverrideSchema.safeParse({ builtin: {}, mcp_servers: { [newMcpServerId()]: 'yes' } })
        .success,
    ).toBe(false)
    expect(ModeToolOverrideSchema.safeParse({ builtin: {}, mcp_servers: [] }).success).toBe(false)
  })

  it('requires a name and a model on create', () => {
    expect(CreateModeRequestSchema.safeParse({ name: 'A' }).success).toBe(false)
    expect(CreateModeRequestSchema.safeParse({ model: 'x/y' }).success).toBe(false)
    expect(CreateModeRequestSchema.safeParse({ name: '', model: 'x/y' }).success).toBe(false)
    expect(
      CreateModeRequestSchema.safeParse({ name: 'A', model: 'x/y', owner_id: 'x' }).success,
    ).toBe(true)
  })

  it('never takes owner_id from a request: the server assigns the owner', () => {
    const created = CreateModeRequestSchema.parse({
      name: 'A',
      model: 'x/y',
      owner_id: 'somebody-else',
    })
    expect(created).not.toHaveProperty('owner_id')
    const updated = UpdateModeRequestSchema.parse({ owner_id: 'somebody-else' })
    expect(updated).not.toHaveProperty('owner_id')
  })

  it('accepts an empty update body, since every field is optional', () => {
    expect(UpdateModeRequestSchema.parse({})).toEqual({})
    expect(UpdateModeRequestSchema.parse({ system_prompt_addition: null })).toEqual({
      system_prompt_addition: null,
    })
    expect(UpdateModeRequestSchema.parse({ reasoning_effort: null })).toEqual({
      reasoning_effort: null,
    })
    expect(UpdateModeRequestSchema.safeParse({ name: '' }).success).toBe(false)
    expect(UpdateModeRequestSchema.safeParse({ reasoning_effort: 'extreme' }).success).toBe(false)
  })

  it('parses the list envelope', () => {
    expect(ListModesResponseSchema.parse({ data: [mode] })).toEqual({ data: [mode] })
    expect(ListModesResponseSchema.parse({ data: [] })).toEqual({ data: [] })
    expect(ListModesResponseSchema.safeParse({ data: {} }).success).toBe(false)
  })

  it('caps a user at twenty modes', () => {
    expect(MAX_MODES_PER_USER).toBe(20)
  })
})
