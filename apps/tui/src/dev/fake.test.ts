import { describe, expect, it } from 'vitest'

import {
  createDevClient,
  DEV_DEFAULT_MODEL,
  DEV_REPLIES,
  DEV_MODES,
  FAKE_CREDENTIALS_ENV,
  FAKE_MODE_ENV,
  FAKE_SIGNED_OUT_ENV,
  isFakeMode,
  isFakeSignedOut,
  isFakeWithCredentials,
} from './fake'

describe('isFakeMode', () => {
  it('is on for the values a person would set', () => {
    expect(isFakeMode({ [FAKE_MODE_ENV]: '1' })).toBe(true)
    expect(isFakeMode({ [FAKE_MODE_ENV]: 'true' })).toBe(true)
    expect(isFakeMode({ [FAKE_MODE_ENV]: ' YES ' })).toBe(true)
  })

  it('is off otherwise', () => {
    expect(isFakeMode({})).toBe(false)
    expect(isFakeMode({ [FAKE_MODE_ENV]: '' })).toBe(false)
    expect(isFakeMode({ [FAKE_MODE_ENV]: '0' })).toBe(false)
    expect(isFakeMode({ [FAKE_MODE_ENV]: 'false' })).toBe(false)
  })
})

describe('isFakeSignedOut (#210)', () => {
  it('is off unless it is asked for, and on for the same values as the fake gate', () => {
    expect(isFakeSignedOut({})).toBe(false)
    expect(isFakeSignedOut({ [FAKE_SIGNED_OUT_ENV]: '0' })).toBe(false)
    expect(isFakeSignedOut({ [FAKE_SIGNED_OUT_ENV]: 'yes' })).toBe(true)
  })
})

describe('isFakeWithCredentials (#245, M6)', () => {
  it('is off unless it is asked for, and on for the same values as the fake gate', () => {
    expect(isFakeWithCredentials({})).toBe(false)
    expect(isFakeWithCredentials({ [FAKE_CREDENTIALS_ENV]: '0' })).toBe(false)
    expect(isFakeWithCredentials({ [FAKE_CREDENTIALS_ENV]: 'false' })).toBe(false)
    expect(isFakeWithCredentials({ [FAKE_CREDENTIALS_ENV]: '1' })).toBe(true)
    expect(isFakeWithCredentials({ [FAKE_CREDENTIALS_ENV]: 'yes' })).toBe(true)
  })
})

describe('createDevClient', () => {
  it('starts with no credentials and no modes, so the first-run flow is reachable', async () => {
    const fake = await createDevClient()

    expect((await fake.providerCredentials.list()).data).toEqual([])
    expect((await fake.modes.list()).data).toEqual([])
  })

  it('seeds a credential per provider and the modes under OPENHARNESS_FAKE_CREDENTIALS', async () => {
    const fake = await createDevClient({ [FAKE_CREDENTIALS_ENV]: '1' })

    // Every provider the catalog lists, so a mode's model is usable.
    const names = (await fake.providerCredentials.list()).data.map((entry) => entry.name).sort()
    expect(names).toEqual(['anthropic', 'google', 'openai'])
    expect((await fake.modes.list()).data.map((mode) => mode.name)).toEqual(
      DEV_MODES.map((mode) => mode.name),
    )
  })

  it('is signed in unless OPENHARNESS_FAKE_SIGNED_OUT asks otherwise (#210)', async () => {
    const signedIn = await createDevClient()
    await expect(signedIn.me()).resolves.toMatchObject({ id: signedIn.user.id })

    const signedOut = await createDevClient({ [FAKE_SIGNED_OUT_ENV]: '1' })
    await expect(signedOut.me()).rejects.toThrow()
    // The device flow is not behind the 401, which is what makes the sign-in offer testable.
    signedOut.scriptDeviceLogin({ outcome: 'approved' })
    const start = await signedOut.auth.startDeviceLogin()
    await expect(signedOut.auth.pollDeviceLogin(start.deviceCode)).resolves.toBeDefined()
    await expect(signedOut.me()).resolves.toMatchObject({ id: signedOut.user.id })
  })

  it('seeds several agents, so `oh agents` and --agent have something to show', async () => {
    const fake = await createDevClient()

    expect((await fake.agents.list()).data.map((agent) => agent.name)).toEqual([
      'Summarizer',
      'Reviewer',
      'Namer',
    ])
  })

  it('seeds a default model, so a new chat starts without the picker (#114)', async () => {
    const fake = await createDevClient()

    expect((await fake.preferences.get()).default_model).toBe(DEV_DEFAULT_MODEL)
    // And the catalog it names is the one the fake serves, so `/model` has rows.
    expect((await fake.models.list()).data.map((model) => model.id)).toContain(DEV_DEFAULT_MODEL)
  })

  it('scripts the replies for the session --continue opens', async () => {
    const fake = await createDevClient()
    const [newest] = (await fake.sessions.list()).data

    await fake.sendMessage(newest?.id ?? '', 'Anything.')
    await fake.waitForIdle(newest?.id)

    const replied = fake
      .history(newest?.id)
      .flatMap((event) =>
        event.type === 'agent.message'
          ? event.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      )

    expect(replied).toContain(DEV_REPLIES[0])
  })

  it('leaves a session with history for --continue and -s', async () => {
    const fake = await createDevClient()
    const [newest] = (await fake.sessions.list()).data

    expect(newest?.title).toBe('A session with history')
    if (newest === undefined) throw new Error('the dev fake has no session to resume')
    expect(fake.history(newest.id).length).toBeGreaterThan(1)
  })
})
