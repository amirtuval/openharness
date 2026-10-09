import { describe, expect, it } from 'vitest'

import { newAgentId, newSessionId } from '../ids'
import { encodeKeyCursor } from '../pagination'
import {
  CreateSessionRequestSchema,
  ListSessionsQuerySchema,
  ListSessionsResponseSchema,
  MAX_INITIAL_EVENTS,
  SessionSchema,
  SessionStatusSchema,
} from './session'

const session = {
  id: newSessionId(),
  type: 'session',
  owner_id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS',
  status: 'idle',
  title: 'README summary',
  metadata: { source: 'test' },
  model: { id: 'anthropic/claude-sonnet-5' },
  system: 'Be concise.',
  agent: {
    id: newAgentId(),
    name: 'Summarizer',
    model: { id: 'anthropic/claude-sonnet-5' },
    system: 'Be concise.',
  },
  created_at: '2026-03-15T10:00:00Z',
  updated_at: '2026-03-15T10:00:00Z',
}

describe('SessionSchema', () => {
  it('parses a session', () => {
    expect(SessionSchema.parse(session)).toEqual(session)
  })

  it('snapshots the agent rather than referencing it', () => {
    // The snapshot carries the agent's fields, not just its id, so an edit to the agent
    // cannot change what an existing session replays to.
    const snapshot = SessionSchema.parse(session).agent
    expect(snapshot).toEqual(session.agent)
    expect(Object.keys(snapshot ?? {}).sort()).toEqual(['id', 'model', 'name', 'system'])
    expect(snapshot?.model).toEqual({ id: 'anthropic/claude-sonnet-5' })
  })

  it('rejects a snapshot that is missing one of its fields', () => {
    for (const field of ['id', 'name', 'model', 'system'] as const) {
      const { [field]: _dropped, ...partial } = session.agent
      expect(
        SessionSchema.safeParse({ ...session, agent: partial }).success,
        `agent without ${field}`,
      ).toBe(false)
    }
  })

  it('carries the effective model and system, always set', () => {
    // These are what the session runs (issue #93), not what its agent happens to hold: a
    // request may override either, and a model-first session has no agent at all.
    expect(SessionSchema.parse(session)).toMatchObject({
      model: { id: 'anthropic/claude-sonnet-5' },
      system: 'Be concise.',
    })
    for (const field of ['model', 'system'] as const) {
      const { [field]: _dropped, ...partial } = session
      expect(SessionSchema.safeParse(partial).success, `session without ${field}`).toBe(false)
    }
    expect(SessionSchema.safeParse({ ...session, model: { id: '' } }).success).toBe(false)
  })

  it('accepts a model-first session: agent null, model set, system possibly null', () => {
    const modelFirst = SessionSchema.parse({
      ...session,
      agent: null,
      model: { id: 'openai/gpt-4.1-mini' },
      system: null,
    })
    expect(modelFirst.agent).toBeNull()
    expect(modelFirst.model).toEqual({ id: 'openai/gpt-4.1-mini' })
    expect(modelFirst.system).toBeNull()
  })

  it('accepts an untitled session with empty metadata', () => {
    expect(SessionSchema.parse({ ...session, title: null, metadata: {} }).title).toBeNull()
  })

  it('requires the owner the server assigned, like agents', () => {
    // Required since #61: the server sets it on every session it creates, and a session
    // owned by someone else answers 404 (A4).
    expect(SessionSchema.parse(session)).toEqual(session)
    const { owner_id: _owner, ...withoutOwner } = session
    expect(SessionSchema.safeParse(withoutOwner).success).toBe(false)
    expect(SessionSchema.safeParse({ ...session, owner_id: '' }).success).toBe(false)
    expect(SessionSchema.safeParse({ ...session, owner_id: null }).success).toBe(false)
  })

  it('rejects the statuses v1 does not have', () => {
    expect(SessionStatusSchema.safeParse('idle').success).toBe(true)
    expect(SessionStatusSchema.safeParse('running').success).toBe(true)
    expect(SessionStatusSchema.safeParse('rescheduling').success).toBe(false)
    expect(SessionStatusSchema.safeParse('terminated').success).toBe(false)
  })

  it('rejects a bad id, a bad status and over-long metadata', () => {
    expect(SessionSchema.safeParse({ ...session, id: newAgentId() }).success).toBe(false)
    expect(SessionSchema.safeParse({ ...session, status: 'busy' }).success).toBe(false)
    expect(SessionSchema.safeParse({ ...session, title: 'x'.repeat(501) }).success).toBe(false)
    expect(
      SessionSchema.safeParse({
        ...session,
        metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_value, index) => [`k${index}`, 'v']),
        ),
      }).success,
    ).toBe(false)
    expect(
      SessionSchema.safeParse({ ...session, metadata: { ['k'.repeat(65)]: 'v' } }).success,
    ).toBe(false)
  })
})

describe('CreateSessionRequestSchema', () => {
  it('accepts an agent id and nothing else', () => {
    const agentId = newAgentId()
    expect(CreateSessionRequestSchema.parse({ agent: agentId })).toEqual({ agent: agentId })
  })

  it('accepts a model and nothing else: a model-first session', () => {
    expect(CreateSessionRequestSchema.parse({ model: { id: 'openai/gpt-4.1-mini' } })).toEqual({
      model: { id: 'openai/gpt-4.1-mini' },
    })
  })

  it('accepts a system override, with an agent or a model', () => {
    const agentId = newAgentId()
    expect(CreateSessionRequestSchema.parse({ agent: agentId, system: 'Be terse.' })).toMatchObject(
      { system: 'Be terse.' },
    )
    expect(
      CreateSessionRequestSchema.parse({ model: { id: 'openai/gpt-4.1-mini' }, system: null }),
    ).toMatchObject({ system: null })
  })

  it('rejects a request that names neither an agent nor a model, with a clear message', () => {
    const result = CreateSessionRequestSchema.safeParse({ title: 'A chat' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/agent or a model/)
  })

  it('rejects a model that is not a provider/model id', () => {
    expect(CreateSessionRequestSchema.safeParse({ model: { id: '' } }).success).toBe(false)
    expect(
      CreateSessionRequestSchema.safeParse({ model: 'anthropic/claude-sonnet-5' }).success,
    ).toBe(false)
  })

  it('accepts a title, metadata and initial events', () => {
    expect(
      CreateSessionRequestSchema.parse({
        agent: newAgentId(),
        title: 'README summary',
        metadata: { source: 'test' },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).toMatchObject({ title: 'README summary' })
  })

  it('rejects a session id where an agent id belongs', () => {
    expect(CreateSessionRequestSchema.safeParse({ agent: newSessionId() }).success).toBe(false)
  })

  it('never takes owner_id from a request: the server assigns the owner', () => {
    const parsed = CreateSessionRequestSchema.parse({
      agent: newAgentId(),
      owner_id: 'somebody-else',
    })
    expect(parsed).not.toHaveProperty('owner_id')
  })

  it('rejects more initial events than Anthropic allows', () => {
    expect(MAX_INITIAL_EVENTS).toBe(50)
    expect(
      CreateSessionRequestSchema.safeParse({
        agent: newAgentId(),
        initial_events: new Array(MAX_INITIAL_EVENTS + 1).fill({ type: 'user.interrupt' }),
      }).success,
    ).toBe(false)
  })

  it('rejects initial events that are not user events', () => {
    expect(
      CreateSessionRequestSchema.safeParse({
        agent: newAgentId(),
        initial_events: [{ type: 'agent.message', content: [{ type: 'text', text: 'hi' }] }],
      }).success,
    ).toBe(false)
  })
})

describe('session list schemas', () => {
  it('parses the query, including the agent filter', () => {
    expect(
      ListSessionsQuerySchema.parse({
        limit: '10',
        page: encodeKeyCursor(session),
        agent_id: session.agent.id,
      }),
    ).toEqual({ limit: 10, page: encodeKeyCursor(session), agent_id: session.agent.id })
    expect(ListSessionsQuerySchema.safeParse({ agent_id: 'agent_nope' }).success).toBe(false)
  })

  it('parses the envelope', () => {
    expect(ListSessionsResponseSchema.parse({ data: [session], next_page: null })).toEqual({
      data: [session],
      next_page: null,
    })
  })
})
