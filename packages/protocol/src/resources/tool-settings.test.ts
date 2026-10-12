import { describe, expect, it } from 'vitest'

import { newModeId } from '../ids'
import {
  BuiltinToolSettingSchema,
  DEFAULT_USER_TOOL_SETTINGS,
  ListToolSettingsQuerySchema,
  ListToolSettingsResponseSchema,
  PutToolSettingsRequestSchema,
  TOOL_NAME_MAX_LENGTH,
  ToolNameSchema,
  ToolSettingEntrySchema,
  UserToolSettingsSchema,
  type ToolSettingEntry,
} from './tool-settings'

const entry: ToolSettingEntry = {
  name: 'web_search',
  source: 'builtin',
  enabled: true,
  policy: 'allow',
  default_policy: 'allow',
  available: true,
}

const setting = { enabled: true, policy: 'allow' } as const

describe('BuiltinToolSettingSchema', () => {
  it('is an on/off and a permission, and strips anything else', () => {
    expect(BuiltinToolSettingSchema.parse({ enabled: false, policy: 'deny' })).toEqual({
      enabled: false,
      policy: 'deny',
    })
    expect(BuiltinToolSettingSchema.parse({ ...setting, extra: 1 })).toEqual(setting)
  })

  it('refuses a missing half, a non-boolean and a permission outside the vocabulary', () => {
    expect(BuiltinToolSettingSchema.safeParse({ enabled: true }).success).toBe(false)
    expect(BuiltinToolSettingSchema.safeParse({ policy: 'allow' }).success).toBe(false)
    expect(BuiltinToolSettingSchema.safeParse({ enabled: 'yes', policy: 'allow' }).success).toBe(
      false,
    )
    expect(BuiltinToolSettingSchema.safeParse({ enabled: true, policy: 'maybe' }).success).toBe(
      false,
    )
  })
})

describe('UserToolSettingsSchema', () => {
  it('holds the built-in map, empty for a user who has chosen nothing', () => {
    expect(UserToolSettingsSchema.parse(DEFAULT_USER_TOOL_SETTINGS)).toEqual({ builtin: {} })
    const settings = { builtin: { web_fetch: { enabled: true, policy: 'ask' } } }
    expect(UserToolSettingsSchema.parse(settings)).toEqual(settings)
  })

  it('refuses a name that is not one, and a setting that is not one', () => {
    expect(UserToolSettingsSchema.safeParse({ builtin: { '': setting } }).success).toBe(false)
    expect(
      UserToolSettingsSchema.safeParse({ builtin: { web_fetch: { enabled: true } } }).success,
    ).toBe(false)
    // The map is required: a stored row always holds one, empty or not.
    expect(UserToolSettingsSchema.safeParse({}).success).toBe(false)
  })

  it('bounds a tool name, so a stored key cannot be a paragraph', () => {
    expect(ToolNameSchema.safeParse('x'.repeat(TOOL_NAME_MAX_LENGTH)).success).toBe(true)
    expect(ToolNameSchema.safeParse('x'.repeat(TOOL_NAME_MAX_LENGTH + 1)).success).toBe(false)
    expect(ToolNameSchema.safeParse('').success).toBe(false)
  })
})

describe('ToolSettingEntrySchema', () => {
  it('carries the effective state, the tool’s own declaration, and whether it is here', () => {
    expect(ToolSettingEntrySchema.parse(entry)).toEqual(entry)
    // An unavailable tool has no declaration to report, and is listed all the same.
    const unavailable = { ...entry, available: false, default_policy: null }
    expect(ToolSettingEntrySchema.parse(unavailable)).toEqual(unavailable)
  })

  it('refuses a missing field, a source outside the vocabulary and a bad permission', () => {
    const { default_policy: _default, ...withoutDefault } = entry
    expect(ToolSettingEntrySchema.safeParse(withoutDefault).success).toBe(false)
    expect(ToolSettingEntrySchema.safeParse({ ...entry, source: 'plugin' }).success).toBe(false)
    expect(ToolSettingEntrySchema.safeParse({ ...entry, policy: 'never' }).success).toBe(false)
    expect(ToolSettingEntrySchema.safeParse({ ...entry, name: '' }).success).toBe(false)
  })
})

describe('the tools endpoints', () => {
  it('wraps the entries in a `data` list, as the other per-user lists do', () => {
    expect(ListToolSettingsResponseSchema.parse({ data: [entry] })).toEqual({ data: [entry] })
    expect(ListToolSettingsResponseSchema.parse({ data: [] })).toEqual({ data: [] })
    expect(ListToolSettingsResponseSchema.safeParse({ data: {} }).success).toBe(false)
    expect(ListToolSettingsResponseSchema.safeParse({}).success).toBe(false)
  })

  it('takes an optional mode, so a read can answer as a chat on it would see things', () => {
    const modeId = newModeId()
    expect(ListToolSettingsQuerySchema.parse({})).toEqual({})
    expect(ListToolSettingsQuerySchema.parse({ mode_id: modeId })).toEqual({ mode_id: modeId })
    expect(ListToolSettingsQuerySchema.safeParse({ mode_id: 'mode_nope' }).success).toBe(false)
  })

  it('takes a merge-style write: a named tool replaces that tool, the rest stay', () => {
    expect(PutToolSettingsRequestSchema.parse({})).toEqual({})
    expect(PutToolSettingsRequestSchema.parse({ builtin: {} })).toEqual({ builtin: {} })
    expect(
      PutToolSettingsRequestSchema.parse({
        builtin: { web_search: { enabled: false, policy: 'ask' } },
      }),
    ).toEqual({ builtin: { web_search: { enabled: false, policy: 'ask' } } })
    expect(
      PutToolSettingsRequestSchema.safeParse({ builtin: { web_search: { policy: 'allow' } } })
        .success,
    ).toBe(false)
  })
})
