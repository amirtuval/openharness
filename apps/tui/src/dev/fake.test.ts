import { describe, expect, it } from 'vitest'

import { createDevClient, DEV_DEFAULT_MODEL, DEV_REPLIES, FAKE_MODE_ENV, isFakeMode } from './fake'

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

describe('createDevClient', () => {
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

  it('scripts the replies the seeded session gives', async () => {
    const fake = await createDevClient()

    await fake.sendMessage(fake.session.id, 'Anything.')
    await fake.waitForIdle()

    const replied = fake
      .history()
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
