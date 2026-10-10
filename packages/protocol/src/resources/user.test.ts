import { describe, expect, it } from 'vitest'

import {
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_THRESHOLD_MIN,
  DEFAULT_MODEL_PATTERN,
  DEFAULT_USER_THEME,
  GetMeResponseSchema,
  GetPreferencesResponseSchema,
  PutPreferencesRequestSchema,
  PreferencesDefaultsSchema,
  SUMMARY_MAX_PASSES_MAX,
  SUMMARY_MAX_PASSES_MIN,
  SUMMARY_MODEL_SAME_AS_CHAT,
  SummaryModelSchema,
  UserIdSchema,
  UserPreferencesSchema,
  UserSchema,
  UserThemeSchema,
  type UserPreferences,
} from './user'

/** The stored shape, with every field present and each compaction control unset. */
const stored: UserPreferences = {
  default_model: null,
  theme: 'system',
  compaction_threshold: null,
  summary_model: SUMMARY_MODEL_SAME_AS_CHAT,
  summary_max_passes: null,
}

/** The defaults the response reports for the two nullable compaction controls. */
const defaults = { compaction_threshold: 0.7, summary_max_passes: 3 }

const user = {
  id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  image: 'https://example.com/ada.png',
  created_at: '2026-03-15T10:00:00Z',
}

describe('UserIdSchema', () => {
  it('accepts any non-empty opaque id', () => {
    // Better Auth mints the id; it is not a `usr_`-prefixed ULID, so the schema only asks
    // that there be one.
    expect(UserIdSchema.parse('Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS')).toBe(
      'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS',
    )
  })

  it('rejects an empty or non-string id', () => {
    expect(UserIdSchema.safeParse('').success).toBe(false)
    expect(UserIdSchema.safeParse(42).success).toBe(false)
  })
})

describe('UserSchema', () => {
  it('parses a user with a name and an image', () => {
    expect(UserSchema.parse(user)).toEqual(user)
  })

  it('parses one without them: a provider may give no profile fields', () => {
    const { name: _name, image: _image, ...bare } = user
    expect(UserSchema.parse(bare)).toEqual(bare)
  })

  it('requires an id, an email and a created_at', () => {
    for (const field of ['id', 'email', 'created_at'] as const) {
      const { [field]: _dropped, ...partial } = user
      expect(UserSchema.safeParse(partial).success, `user without ${field}`).toBe(false)
    }
  })

  it('rejects an empty id and a malformed email', () => {
    expect(UserSchema.safeParse({ ...user, id: '' }).success).toBe(false)
    expect(UserSchema.safeParse({ ...user, email: 'not-an-email' }).success).toBe(false)
  })

  it('rejects a malformed timestamp and a non-string name', () => {
    expect(UserSchema.safeParse({ ...user, created_at: 'yesterday' }).success).toBe(false)
    expect(UserSchema.safeParse({ ...user, name: 7 }).success).toBe(false)
  })

  it('strips fields Better Auth keeps but the wire does not carry', () => {
    const parsed = UserSchema.parse({ ...user, emailVerified: true, twoFactorEnabled: false })
    expect(parsed).toEqual(user)
  })
})

describe('GetMeResponseSchema', () => {
  it('is the user object itself, unwrapped', () => {
    expect(GetMeResponseSchema).toBe(UserSchema)
    expect(GetMeResponseSchema.parse(user)).toEqual(user)
  })

  it('rejects the check-it-somewhere-else shapes a wrapper would have', () => {
    expect(GetMeResponseSchema.safeParse({ data: user }).success).toBe(false)
    expect(GetMeResponseSchema.safeParse([user]).success).toBe(false)
  })
})

describe('UserPreferencesSchema (epic #116, U1)', () => {
  it('parses a default model, a cleared one, and the theme beside them', () => {
    expect(
      UserPreferencesSchema.parse({
        ...stored,
        default_model: 'anthropic/claude-sonnet-5',
        theme: 'dark',
      }),
    ).toEqual({
      ...stored,
      default_model: 'anthropic/claude-sonnet-5',
      theme: 'dark',
    })
    expect(UserPreferencesSchema.parse(stored)).toEqual(stored)
  })

  it('takes only the four theme names', () => {
    for (const theme of ['system', 'light', 'dim', 'dark']) {
      expect(UserThemeSchema.parse(theme)).toBe(theme)
    }
    for (const bad of ['Dark', 'midnight', '', null, 42]) {
      expect(UserThemeSchema.safeParse(bad).success, String(bad)).toBe(false)
    }
    expect(DEFAULT_USER_THEME).toBe('system')
  })

  it('accepts a free-text id the catalog may not have, and a slash in the model part', () => {
    // The shape is all that is validated: `provider/model`, free text, and a provider's own
    // model id may itself contain a slash.
    expect(DEFAULT_MODEL_PATTERN.test('mistral/codestral-latest')).toBe(true)
    expect(DEFAULT_MODEL_PATTERN.test('openrouter/meta-llama/llama-3.1-70b')).toBe(true)
    expect(
      UserPreferencesSchema.safeParse({ ...stored, default_model: 'some-new/model-v2' }).success,
    ).toBe(true)
  })

  it('requires every field of the stored shape, and an object around it', () => {
    // What the server holds always has them all: a missing field on a *read* is a server bug,
    // not an absent preference.
    expect(UserPreferencesSchema.safeParse({}).success).toBe(false)
    for (const field of [
      'default_model',
      'theme',
      'compaction_threshold',
      'summary_model',
      'summary_max_passes',
    ] as const) {
      const { [field]: _dropped, ...partial } = stored
      expect(UserPreferencesSchema.safeParse(partial).success, `without ${field}`).toBe(false)
    }
    expect(UserPreferencesSchema.safeParse('anthropic/claude-sonnet-5').success).toBe(false)
  })

  it('rejects ids that are not `provider/model` shaped', () => {
    for (const bad of [
      '',
      'anthropic', // no model
      '/claude', // empty provider
      'anthropic/', // empty model
      'anthropic//claude', // empty segment
      ' anthropic/claude', // whitespace
      'anthropic/claude sonnet', // whitespace in the model
      42,
    ]) {
      expect(
        UserPreferencesSchema.safeParse({ ...stored, default_model: bad }).success,
        String(bad),
      ).toBe(false)
    }
  })

  it('strips unknown preference fields rather than rejecting them', () => {
    expect(UserPreferencesSchema.parse({ ...stored, future: { x: 1 } })).toEqual(stored)
  })

  it('Get is the stored shape plus the defaults its nulls mean; Put is every field, optional', () => {
    // The response adds one object — what `compaction_threshold: null` and
    // `summary_max_passes: null` fall back to — to the stored shape (#282).
    expect(GetPreferencesResponseSchema.parse({ ...stored, defaults: defaults })).toEqual({
      ...stored,
      defaults,
    })
    expect(GetPreferencesResponseSchema.safeParse(stored).success).toBe(false)

    // A write merges (epic #201, X3): each field may stand alone, so a caller changing one
    // cannot clear the others, and an empty body is a no-op rather than a reset.
    expect(PutPreferencesRequestSchema.parse({ default_model: 'openai/gpt-5-mini' })).toEqual({
      default_model: 'openai/gpt-5-mini',
    })
    expect(PutPreferencesRequestSchema.parse({ theme: 'dim' })).toEqual({ theme: 'dim' })
    expect(PutPreferencesRequestSchema.parse({ default_model: null, theme: 'dark' })).toEqual({
      default_model: null,
      theme: 'dark',
    })
    expect(PutPreferencesRequestSchema.parse({})).toEqual({})

    // The same checks a whole write got: the default model's shape, and the four theme names.
    expect(
      PutPreferencesRequestSchema.safeParse({ default_model: 'not-a-router-id' }).success,
    ).toBe(false)
    expect(PutPreferencesRequestSchema.safeParse({ theme: 'midnight' }).success).toBe(false)
  })
})

describe('the compaction preferences (epic #277, C3; #282)', () => {
  it('bounds the threshold to 30%..95%, and takes null for the server default', () => {
    expect(COMPACTION_THRESHOLD_MIN).toBe(0.3)
    expect(COMPACTION_THRESHOLD_MAX).toBe(0.95)
    for (const value of [0.3, 0.5, 0.7, 0.95]) {
      expect(UserPreferencesSchema.parse({ ...stored, compaction_threshold: value })).toEqual({
        ...stored,
        compaction_threshold: value,
      })
    }
    // Outside the range, or not a number at all — `null` is the "server default" choice and is
    // tested on its own below.
    for (const bad of [0.29, 0.96, 0, 1, -1, '0.7']) {
      expect(
        UserPreferencesSchema.safeParse({ ...stored, compaction_threshold: bad }).success,
        String(bad),
      ).toBe(false)
    }
    expect(
      UserPreferencesSchema.parse({ ...stored, compaction_threshold: null }).compaction_threshold,
    ).toBeNull()
  })

  it('takes the same-as-chat sentinel or a `provider/model` summary model', () => {
    expect(SUMMARY_MODEL_SAME_AS_CHAT).toBe('same-as-chat')
    expect(SummaryModelSchema.parse(SUMMARY_MODEL_SAME_AS_CHAT)).toBe(SUMMARY_MODEL_SAME_AS_CHAT)
    expect(SummaryModelSchema.parse('openai/gpt-5-mini')).toBe('openai/gpt-5-mini')
    expect(SummaryModelSchema.parse('openrouter/meta-llama/llama-3.1-70b')).toBe(
      'openrouter/meta-llama/llama-3.1-70b',
    )
    for (const bad of ['', 'openai', '/gpt', 'openai/', 'same as chat', 42]) {
      expect(SummaryModelSchema.safeParse(bad).success, String(bad)).toBe(false)
    }
  })

  it('bounds the pass limit to 1..10, and takes null for the engine default', () => {
    expect(SUMMARY_MAX_PASSES_MIN).toBe(1)
    expect(SUMMARY_MAX_PASSES_MAX).toBe(10)
    for (const value of [1, 3, 10]) {
      expect(UserPreferencesSchema.parse({ ...stored, summary_max_passes: value })).toEqual({
        ...stored,
        summary_max_passes: value,
      })
    }
    for (const bad of [0, 11, 1.5, '3']) {
      expect(
        UserPreferencesSchema.safeParse({ ...stored, summary_max_passes: bad }).success,
        String(bad),
      ).toBe(false)
    }
    expect(
      UserPreferencesSchema.parse({ ...stored, summary_max_passes: null }).summary_max_passes,
    ).toBeNull()
  })

  it('requires both defaults in the response, and strips unknown ones', () => {
    expect(PreferencesDefaultsSchema.parse(defaults)).toEqual(defaults)
    expect(PreferencesDefaultsSchema.safeParse({ compaction_threshold: 0.7 }).success).toBe(false)
    expect(
      PreferencesDefaultsSchema.safeParse({ ...defaults, summary_max_passes: 2.5 }).success,
    ).toBe(false)
    expect(PreferencesDefaultsSchema.parse({ ...defaults, future: 1 })).toEqual(defaults)
  })

  it('accepts the compaction fields on a PUT, each on its own and each optional', () => {
    expect(PutPreferencesRequestSchema.parse({ compaction_threshold: 0.5 })).toEqual({
      compaction_threshold: 0.5,
    })
    expect(PutPreferencesRequestSchema.parse({ summary_model: 'openai/gpt-5-mini' })).toEqual({
      summary_model: 'openai/gpt-5-mini',
    })
    expect(PutPreferencesRequestSchema.parse({ summary_max_passes: 5 })).toEqual({
      summary_max_passes: 5,
    })
    // A cleared control is `null`, exactly as a cleared default model is.
    expect(
      PutPreferencesRequestSchema.parse({ compaction_threshold: null, summary_max_passes: null }),
    ).toEqual({ compaction_threshold: null, summary_max_passes: null })

    for (const bad of [
      { compaction_threshold: 0.1 },
      { compaction_threshold: 1 },
      { summary_model: 'not-a-router-id' },
      { summary_max_passes: 0 },
      { summary_max_passes: 11 },
    ]) {
      expect(PutPreferencesRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })
})
