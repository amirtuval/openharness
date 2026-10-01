import { describe, expect, it } from 'vitest'

import { GetMeResponseSchema, UserIdSchema, UserSchema } from './user'

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
