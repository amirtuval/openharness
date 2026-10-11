import type { AgentMcpToolUseEvent, StoredEvent, ToolInput } from '@openharness/protocol'
import { newEventId } from '@openharness/protocol'
import { makeAgentToolResult, makeAgentToolUse } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { RESOLVED_BY_MESSAGE } from './pausing'
import {
  STUCK_END_STREAK,
  STUCK_REMINDER_STREAK,
  canonicalJson,
  isFailure,
  stuckEnd,
  stuckReminder,
  stuckStreak,
} from './stuck'

/**
 * Stuck detection read off the log (#331).
 *
 * The pure half: what a streak is, when the reminder fires and when the turn ends. The loop's
 * half — the reminder reaching a request and being recorded on its span, and the turn ending with
 * the notice — is in `tool-loop.test.ts`.
 */

/** The `seq` a hand-built log assigns, counting like a store's. */
function seqs(): () => number {
  let seq = 0
  return () => {
    seq += 1
    return seq
  }
}

/**
 * A log of identical calls to one tool, with one result each.
 *
 * @param count how many calls (and results) to make
 * @param options the tool name and input every call shares, whether the results are errors, and
 *   the result text (`''` uses the default).
 */
function repeated(
  count: number,
  options: {
    readonly name?: string
    readonly input?: ToolInput
    readonly error?: boolean
    readonly result?: string
  } = {},
): StoredEvent[] {
  const next = seqs()
  const events: StoredEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const call = makeAgentToolUse(options.name ?? 'fetch', options.input ?? { url: 'a' }, {
      seq: next(),
    })
    events.push(call)
    events.push(
      makeAgentToolResult(call, options.result ?? 'the page', {
        seq: next(),
        is_error: options.error === true,
      }),
    )
  }
  return events
}

/** A `user.message` at `seq`, for opening a turn. */
function userMessage(seq: number, text = 'go'): StoredEvent {
  return {
    id: newEventId(),
    type: 'user.message',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text }],
  }
}

/** A `session.status_idle` at `seq` — what closes a turn. */
function idle(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: 'session.status_idle',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    stop_reason: { type: 'end_turn' },
  }
}

/** A stored `span.model_request_start` that carried a stuck reminder — the one-time record. */
function remindedSpan(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: 'span.model_request_start',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    consumes: [],
    model: 'anthropic/claude-sonnet-5',
    reminders: [{ kind: 'stuck', tokens: 30 }],
  }
}

/** A remote MCP call to `server.tool`, shaped as the loop stores one (#312). */
function mcpCall(seq: number, name: string, input: ToolInput): AgentMcpToolUseEvent {
  return {
    id: newEventId(),
    type: 'agent.mcp_tool_use',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    mcp_server_name: 'notes',
    name,
    input,
    evaluated_permission: 'allow',
  }
}

/** A stored `agent.mcp_tool_result` answering an MCP call. */
function mcpResult(
  call: AgentMcpToolUseEvent,
  seq: number,
  text: string,
  isError = false,
): StoredEvent {
  return {
    id: newEventId(),
    type: 'agent.mcp_tool_result',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    mcp_tool_use_id: call.id,
    content: [{ type: 'text', text }],
    is_error: isError,
  }
}

describe('the identical run of newest calls (#331)', () => {
  it('counts the run and reports what it shares', () => {
    const streak = stuckStreak(repeated(3))
    expect(streak).toEqual({
      length: 3,
      name: 'fetch',
      input: canonicalJson({ url: 'a' }),
      startedAt: 1,
      failures: 0,
    })
  })

  it('is null for a turn that called no tool', () => {
    expect(stuckStreak([userMessage(1)])).toBeNull()
  })

  it('ends where the arguments stop matching, key order included', () => {
    const events = [
      ...repeated(2, { input: { url: 'a', depth: 1 } }),
      // The same arguments in another key order are the same call: canonical JSON says so.
      makeAgentToolUse('fetch', { depth: 1, url: 'a' }, { seq: 5 }),
      makeAgentToolUse('fetch', { url: 'b' }, { seq: 6 }),
      makeAgentToolUse('fetch', { url: 'b' }, { seq: 7 }),
    ]
    expect(stuckStreak(events)).toMatchObject({ length: 2, input: canonicalJson({ url: 'b' }) })
  })

  it('ends at a different tool name', () => {
    const events = [
      makeAgentToolUse('fetch', { url: 'a' }, { seq: 1 }),
      makeAgentToolUse('search', { q: 'a' }, { seq: 2 }),
    ]
    expect(stuckStreak(events)).toMatchObject({ length: 1, name: 'search' })
  })

  it('counts a call that has no answer yet', () => {
    const events = [
      makeAgentToolUse('fetch', { url: 'a' }, { seq: 1 }),
      makeAgentToolUse('fetch', { url: 'a' }, { seq: 2 }),
    ]
    expect(stuckStreak(events)).toMatchObject({ length: 2, failures: 0 })
  })

  it('is scoped to the turn: an idle event ends the run', () => {
    const first = repeated(3)
    const events: StoredEvent[] = [...first, idle(first.length + 1), userMessage(first.length + 2)]
    expect(stuckStreak(events)).toBeNull()

    const second = repeated(2).map((event) => ({ ...event, seq: event.seq + first.length + 2 }))
    expect(stuckStreak([...events, ...second])).toMatchObject({ length: 2 })
  })

  it('counts a remote MCP call like a built-in one', () => {
    const call = mcpCall(1, 'search', { query: 'roadmap' })
    const events = [call, mcpResult(call, 2, 'nothing found', true)]
    expect(stuckStreak(events)).toMatchObject({ length: 1, name: 'notes__search', failures: 1 })
  })
})

describe('what counts as a failure (#331)', () => {
  const call = makeAgentToolUse('fetch', { url: 'a' })

  it('is an error result the tool produced', () => {
    expect(isFailure(call, makeAgentToolResult(call, 'boom', { is_error: true }))).toBe(true)
    expect(isFailure(call, makeAgentToolResult(call, 'ok'))).toBe(false)
    expect(isFailure(call, undefined)).toBe(false)
  })

  it('is not a denial the policy made', () => {
    const denied = makeAgentToolUse('fetch', { url: 'a' }, { evaluated_permission: 'deny' })
    expect(
      isFailure(
        denied,
        makeAgentToolResult(denied, 'Permission to use fetch has been denied.', {
          is_error: true,
        }),
      ),
    ).toBe(false)
  })

  it('is not a denial the user made, nor an interrupt, nor a message that ended the wait', () => {
    for (const text of [
      'The user denied this.',
      'The user denied this: no',
      'Interrupted by the user.',
      RESOLVED_BY_MESSAGE,
    ]) {
      expect(isFailure(call, makeAgentToolResult(call, text, { is_error: true }))).toBe(false)
    }
  })
})

describe('the stuck reminder (#331)', () => {
  it('fires at five identical calls, worded for identical results', () => {
    expect(stuckReminder(repeated(STUCK_REMINDER_STREAK - 1))).toBeNull()
    const reminder = stuckReminder(repeated(STUCK_REMINDER_STREAK))
    expect(reminder).toMatchObject({
      kind: 'stuck',
      variant: 'results',
      streak: STUCK_REMINDER_STREAK,
    })
    expect(reminder?.text).toContain('You have called fetch with the same arguments 5 times')
    expect(reminder?.text).toContain('move on')
  })

  it('is worded for identical errors when the repeated call keeps failing', () => {
    const reminder = stuckReminder(repeated(STUCK_REMINDER_STREAK, { error: true }))
    expect(reminder).toMatchObject({ variant: 'errors' })
    expect(reminder?.text).toContain('failed the same way')
    expect(reminder?.text).toContain('try something different')
  })

  it('does not fire again for the same streak once a span recorded it', () => {
    const events = repeated(6)
    expect(stuckReminder(events)).not.toBeNull()
    const recorded: StoredEvent[] = [
      ...events.slice(0, 2),
      remindedSpan(3),
      ...events.slice(2).map((event) => ({ ...event, seq: event.seq + 1 })),
    ]
    expect(stuckReminder(recorded)).toBeNull()
  })

  it('fires again for a new streak, after a different argument reset it', () => {
    const events: StoredEvent[] = [...repeated(5), remindedSpan(11)]
    const reset: StoredEvent[] = [...repeated(5, { input: { url: 'b' } })].map((event) => ({
      ...event,
      seq: event.seq + 11,
    }))
    expect(stuckReminder([...events, ...reset])).not.toBeNull()
  })

  it('offers nothing once the turn should end instead', () => {
    expect(stuckReminder(repeated(STUCK_END_STREAK, { error: true }))).toBeNull()
  })
})

describe('ending a turn on a stuck loop (#331)', () => {
  it('ends at eight identical failing calls, and not before', () => {
    expect(stuckEnd(repeated(STUCK_END_STREAK - 1, { error: true }))).toBeNull()
    expect(stuckEnd(repeated(STUCK_END_STREAK, { error: true }))).toMatchObject({
      length: STUCK_END_STREAK,
      failures: STUCK_END_STREAK,
    })
  })

  it('never ends a run of identical calls that keep succeeding', () => {
    expect(stuckEnd(repeated(STUCK_END_STREAK))).toBeNull()
    expect(stuckEnd(repeated(STUCK_END_STREAK + 2))).toBeNull()
  })

  it('is not reached by calls the policy denied, the user denied, or an interrupt cut short', () => {
    const denied = makeAgentToolUse('fetch', { url: 'a' }, { evaluated_permission: 'deny' })
    const built: StoredEvent[] = []
    for (let index = 0; index < STUCK_END_STREAK; index += 1) {
      built.push(
        denied,
        makeAgentToolResult(denied, 'Permission to use fetch has been denied.', { is_error: true }),
      )
    }
    expect(stuckEnd(built)).toBeNull()

    const interrupted: StoredEvent[] = repeated(STUCK_END_STREAK).map((event) =>
      event.type === 'agent.tool_result'
        ? {
            ...event,
            content: [{ type: 'text' as const, text: 'Interrupted by the user.' }],
            is_error: true,
          }
        : event,
    )
    expect(stuckEnd(interrupted)).toBeNull()
  })

  it('counts a remote MCP tool failing the same way', () => {
    const events: StoredEvent[] = []
    let seq = 0
    for (let index = 0; index < STUCK_END_STREAK; index += 1) {
      seq += 1
      const call = mcpCall(seq, 'search', { query: 'roadmap' })
      seq += 1
      events.push(call, mcpResult(call, seq, 'the server is down', true))
    }
    const streak = stuckEnd(events)
    expect(streak).toMatchObject({ length: STUCK_END_STREAK, name: 'notes__search' })
    expect(streak?.failures).toBe(STUCK_END_STREAK)
  })
})

describe('canonical JSON (#331)', () => {
  it('sorts keys at every depth and keeps arrays in order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]')
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
  })
})
