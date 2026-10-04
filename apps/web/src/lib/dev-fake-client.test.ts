import { createFakeClient } from '@openharness/client/testing'
import { describe, expect, it } from 'vitest'

import { seedFakeScenario } from './dev-fake-client'

describe('fake mode', () => {
  it('seeds a second agent, a session with a turn in its log, and a scripted reply', async () => {
    const fake = createFakeClient()
    await seedFakeScenario(fake)

    const agents = (await fake.agents.list()).data
    expect(agents.map((agent) => agent.name)).toEqual(['Summarizer', 'Assistant'])

    const sessions = (await fake.sessions.list()).data
    expect(sessions).toHaveLength(2)
    const seeded = sessions.find((session) => session.title === 'What can you do?')
    expect(seeded).toBeDefined()

    const history = fake.history(seeded?.id)
    expect(history.some((event) => event.type === 'user.message')).toBe(true)
    const reply = history.find((event) => event.type === 'agent.message')
    expect(reply).toBeDefined()
    expect(reply?.type === 'agent.message' && reply.content[0]?.text).toMatch(/fake client/)

    // The first turn was answered by the script, so it is not the fake's default reply.
    expect(sessions.map((session) => session.status)).toEqual(['idle', 'idle'])
  })
})
