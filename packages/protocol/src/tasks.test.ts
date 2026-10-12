import { describe, expect, it } from 'vitest'

import { newTaskId, parseId } from './ids'
import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  AgentMessageToolInputSchema,
  AgentStopToolInputSchema,
  AgentToolInputSchema,
  DEFAULT_MAX_AGENT_DEPTH,
  DEFAULT_MAX_LIVE_TASKS,
  MESSAGE_PARENT_TOOL_NAME,
  MessageParentToolInputSchema,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_WAIT_DEFAULT_TIMEOUT_MS,
  TASK_WAIT_MAX_TIMEOUT_MS,
  TaskWaitInputSchema,
  isTaskId,
  parseTaskWaitInput,
  taskWaitTimeoutMs,
} from './index'

describe('task ids', () => {
  it('names one background task', () => {
    const id = newTaskId()
    expect(id).toMatch(/^task_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(parseId(id).type).toBe('task')
  })

  it('tells a task id from a session or event id', () => {
    expect(isTaskId(newTaskId())).toBe(true)
    expect(isTaskId('sesn_01JQZ8W9K2M4N6P8R0T2V4X6Y8')).toBe(false)
    expect(isTaskId('task_not-a-ulid')).toBe(false)
  })
})

describe('what a task wait asks for', () => {
  it('takes the tasks and a timeout, both optional', () => {
    expect(TaskWaitInputSchema.safeParse({}).success).toBe(true)
    expect(TaskWaitInputSchema.safeParse({ task_ids: [newTaskId()] }).success).toBe(true)
    expect(TaskWaitInputSchema.safeParse({ timeout_s: 30 }).success).toBe(true)
  })

  it('refuses something that is not a task id', () => {
    expect(TaskWaitInputSchema.safeParse({ task_ids: ['sesn_abc'] }).success).toBe(false)
  })

  it('reads a call as a wait, or as nothing', () => {
    expect(parseTaskWaitInput({ timeout_s: 5 })).toEqual({ timeout_s: 5 })
    expect(parseTaskWaitInput({ timeout_s: '5' })).toBeNull()
    expect(parseTaskWaitInput('wait')).toBeNull()
  })
})

describe('how long a wait lasts', () => {
  it('takes what the call asked for', () => {
    expect(taskWaitTimeoutMs({ timeout_s: 30 })).toBe(30_000)
  })

  it('defaults a call that asked for nothing, and one that asked for nonsense', () => {
    expect(taskWaitTimeoutMs(null)).toBe(TASK_WAIT_DEFAULT_TIMEOUT_MS)
    expect(taskWaitTimeoutMs({})).toBe(TASK_WAIT_DEFAULT_TIMEOUT_MS)
    expect(taskWaitTimeoutMs({ timeout_s: 0 })).toBe(TASK_WAIT_DEFAULT_TIMEOUT_MS)
    expect(taskWaitTimeoutMs({ timeout_s: -5 })).toBe(TASK_WAIT_DEFAULT_TIMEOUT_MS)
  })

  it('caps a wait longer than an hour', () => {
    expect(taskWaitTimeoutMs({ timeout_s: 86_400 })).toBe(TASK_WAIT_MAX_TIMEOUT_MS)
  })
})

describe('the subagent tools’ names and inputs (S5; #344)', () => {
  it('spells the five names once, the way the model is offered them', () => {
    expect(AGENT_TOOL_NAME).toBe('agent')
    expect(AGENT_MESSAGE_TOOL_NAME).toBe('agent_message')
    expect(AGENT_STOP_TOOL_NAME).toBe('agent_stop')
    expect(MESSAGE_PARENT_TOOL_NAME).toBe('message_parent')
  })

  it('parses what an `agent` call carries', () => {
    expect(
      AgentToolInputSchema.parse({
        type: 'general-purpose',
        description: 'Check how a rewind works',
        prompt: 'Read the rewind code and report.',
      }),
    ).toMatchObject({ type: 'general-purpose' })
  })

  it('refuses an `agent` call with nothing to run or nothing to call it', () => {
    const ok = {
      type: 'researcher',
      description: 'Look it up',
      prompt: 'Look it up and report.',
    }
    expect(AgentToolInputSchema.safeParse({ ...ok, type: '' }).success).toBe(false)
    expect(AgentToolInputSchema.safeParse({ ...ok, description: '' }).success).toBe(false)
    expect(AgentToolInputSchema.safeParse({ ...ok, prompt: '' }).success).toBe(false)
    // The description is bounded like every other free text a caller sets (`#343`); the prompt
    // is not, because it is a message — the child's first.
    expect(
      AgentToolInputSchema.safeParse({ ...ok, description: 'x'.repeat(TASK_DESCRIPTION_MAX_LENGTH + 1) })
        .success,
    ).toBe(false)
    expect(AgentToolInputSchema.safeParse({ ...ok, prompt: 'x'.repeat(4000) }).success).toBe(true)
  })

  it('parses a message to a task and a stop, both by task id', () => {
    const taskId = newTaskId()
    expect(AgentMessageToolInputSchema.parse({ task_id: taskId, text: 'keep going' })).toEqual({
      task_id: taskId,
      text: 'keep going',
    })
    expect(AgentStopToolInputSchema.parse({ task_id: taskId })).toEqual({ task_id: taskId })
    expect(AgentMessageToolInputSchema.safeParse({ task_id: 'sesn_abc', text: 'hi' }).success).toBe(
      false,
    )
    expect(AgentStopToolInputSchema.safeParse({ task_id: taskId, text: 'hi' }).success).toBe(true)
  })

  it('parses a child’s note to its parent, which addresses nobody', () => {
    expect(MessageParentToolInputSchema.parse({ text: 'halfway there' })).toEqual({
      text: 'halfway there',
    })
    expect(MessageParentToolInputSchema.safeParse({ text: '' }).success).toBe(false)
    // The parent and the task are the session's own (`parent_session_id`, `parent_task_id`), so
    // there is no field for either and an unknown one is stripped like any other.
    expect(
      MessageParentToolInputSchema.parse({ text: 'hi', task_id: newTaskId() }),
    ).toEqual({ text: 'hi' })
  })

  it('defaults the nesting limits to three and ten (S6)', () => {
    expect(DEFAULT_MAX_AGENT_DEPTH).toBe(3)
    expect(DEFAULT_MAX_LIVE_TASKS).toBe(10)
  })
})
