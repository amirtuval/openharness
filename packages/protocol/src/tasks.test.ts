import { describe, expect, it } from 'vitest'

import { newTaskId, parseId } from './ids'
import {
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
