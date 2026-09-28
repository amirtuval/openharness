import { describe, expect, it } from 'vitest'

import { newAgentId } from '../ids'
import { encodePageCursor } from '../pagination'
import {
  AgentSchema,
  CreateAgentRequestSchema,
  ListAgentsQuerySchema,
  ListAgentsResponseSchema,
  ModelConfigSchema,
  UpdateAgentRequestSchema,
} from './agent'

const agent = {
  id: newAgentId(),
  type: 'agent',
  name: 'Summarizer',
  description: 'Summarizes a repository.',
  model: { id: 'anthropic/claude-sonnet-5' },
  system: 'Be concise.',
  created_at: '2026-03-15T10:00:00Z',
  updated_at: '2026-03-15T10:00:00Z',
}

describe('AgentSchema', () => {
  it('parses an agent', () => {
    expect(AgentSchema.parse(agent)).toEqual(agent)
  })

  it('carries a Mastra model-router string in model.id', () => {
    expect(ModelConfigSchema.parse({ id: 'anthropic/claude-sonnet-5' }).id).toBe(
      'anthropic/claude-sonnet-5',
    )
    expect(AgentSchema.parse(agent).model.id).toBe('anthropic/claude-sonnet-5')
  })

  it('drops the model config Anthropic returns but v1 does not store', () => {
    const { model, ...rest } = agent
    const parsed = AgentSchema.parse({
      ...rest,
      model: { ...model, effort: { type: 'low' }, speed: 'standard' },
    })
    expect(parsed.model).toEqual({ id: 'anthropic/claude-sonnet-5' })
  })

  it('accepts explicit nulls for description and system', () => {
    expect(AgentSchema.parse({ ...agent, description: null, system: null }).description).toBeNull()
  })

  it('rejects a bad id, an empty name and a missing timestamp', () => {
    expect(AgentSchema.safeParse({ ...agent, id: 'agent_nope' }).success).toBe(false)
    expect(
      AgentSchema.safeParse({ ...agent, id: newAgentId().replace('agent_', 'sesn_') }).success,
    ).toBe(false)
    expect(AgentSchema.safeParse({ ...agent, name: '' }).success).toBe(false)
    expect(AgentSchema.safeParse({ ...agent, name: 'x'.repeat(257) }).success).toBe(false)
    const { updated_at: _updated, ...withoutUpdatedAt } = agent
    expect(AgentSchema.safeParse(withoutUpdatedAt).success).toBe(false)
  })
})

describe('agent request schemas', () => {
  it('accepts a minimal create body', () => {
    expect(CreateAgentRequestSchema.parse({ name: 'A', model: { id: 'x/y' } })).toEqual({
      name: 'A',
      model: { id: 'x/y' },
    })
  })

  it('requires a name and a model on create', () => {
    expect(CreateAgentRequestSchema.safeParse({ name: 'A' }).success).toBe(false)
    expect(CreateAgentRequestSchema.safeParse({ model: { id: 'x/y' } }).success).toBe(false)
    expect(CreateAgentRequestSchema.safeParse({ name: 'A', model: { id: '' } }).success).toBe(false)
  })

  it('accepts an empty update body, since every field is optional', () => {
    expect(UpdateAgentRequestSchema.parse({})).toEqual({})
    expect(UpdateAgentRequestSchema.parse({ system: null })).toEqual({ system: null })
    expect(UpdateAgentRequestSchema.safeParse({ name: '' }).success).toBe(false)
  })

  it('parses the list query and envelope', () => {
    expect(
      ListAgentsQuerySchema.parse({ limit: '20', page: encodePageCursor({ seq: 20 }) }),
    ).toEqual({
      limit: 20,
      page: encodePageCursor({ seq: 20 }),
    })
    expect(ListAgentsResponseSchema.parse({ data: [agent], next_page: null })).toEqual({
      data: [agent],
      next_page: null,
    })
    expect(ListAgentsResponseSchema.safeParse({ data: {}, next_page: null }).success).toBe(false)
  })
})
