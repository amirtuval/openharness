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
  status: 'idle',
  title: 'README summary',
  metadata: { source: 'test' },
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
    expect(Object.keys(snapshot).sort()).toEqual(['id', 'model', 'name', 'system'])
    expect(snapshot.model).toEqual({ id: 'anthropic/claude-sonnet-5' })
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

  it('accepts an untitled session with empty metadata', () => {
    expect(SessionSchema.parse({ ...session, title: null, metadata: {} }).title).toBeNull()
  })

  it('carries the owner the server assigned, and tolerates its absence for now', () => {
    // Same transition as agents: pre-auth sessions (through #61) may have no owner; after
    // #61 the server always sets it, and a session owned by someone else answers 404.
    expect(
      SessionSchema.parse({ ...session, owner_id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS' }),
    ).toEqual({ ...session, owner_id: 'Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS' })
    expect(SessionSchema.parse(session)).toEqual(session)
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
