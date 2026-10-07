import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODEL_PATTERN,
  DEFAULT_USER_THEME,
  GetMeResponseSchema,
  GetPreferencesResponseSchema,
  PutPreferencesRequestSchema,
  UserIdSchema,
  UserPreferencesSchema,
  UserSchema,
  UserThemeSchema,
} from './user'

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
        default_model: 'anthropic/claude-sonnet-5',
        theme: 'dark',
      }),
    ).toEqual({ default_model: 'anthropic/claude-sonnet-5', theme: 'dark' })
    expect(UserPreferencesSchema.parse({ default_model: null, theme: 'system' })).toEqual({
      default_model: null,
      theme: 'system',
    })
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
      UserPreferencesSchema.safeParse({ default_model: 'some-new/model-v2', theme: 'system' })
        .success,
    ).toBe(true)
  })

  it('requires every field of the stored shape, and an object around it', () => {
    // What the server holds always has both: a missing `theme` on a *read* is a server bug,
    // not an absent preference.
    expect(UserPreferencesSchema.safeParse({}).success).toBe(false)
    expect(UserPreferencesSchema.safeParse({ default_model: null }).success).toBe(false)
    expect(UserPreferencesSchema.safeParse({ theme: 'dark' }).success).toBe(false)
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
        UserPreferencesSchema.safeParse({ default_model: bad, theme: 'system' }).success,
        String(bad),
      ).toBe(false)
    }
  })

  it('strips unknown preference fields rather than rejecting them', () => {
    expect(
      UserPreferencesSchema.parse({ default_model: null, theme: 'dark', future: { x: 1 } }),
    ).toEqual({ default_model: null, theme: 'dark' })
  })

  it('Get is the stored shape; Put is every field of it, each one optional', () => {
    expect(GetPreferencesResponseSchema).toBe(UserPreferencesSchema)

    // A write merges (epic #201, X3): each field may stand alone, so a caller changing one
    // cannot clear the other, and an empty body is a no-op rather than a reset.
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
