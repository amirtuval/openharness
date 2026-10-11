import { describe, expect, it } from 'vitest'

import {
  makeAgentMcpToolResult,
  makeAgentMcpToolUse,
  makeAgentMessage,
  makeAgentToolResult,
  makeAgentToolUse,
  makeModelRequestStart,
  makeSessionError,
  makeSessionRewind,
  makeStatusIdle,
  makeStatusRunning,
  makeToolConfirmation,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import { newEventId } from '@openharness/protocol'
import type { StreamEvent } from '@openharness/protocol'

import {
  initialTranscriptState,
  reduceTranscriptAll,
  selectClearedToolResults,
  selectConfirmation,
  selectConfirmations,
  selectMcpFailure,
  selectSearchCount,
  selectToolCalls,
  selectTranscriptEntries,
  selectTodos,
  selectTruncatedToolResults,
} from './transcript'

/** Fold a sequence of events into a fresh transcript. */
function reduce(events: readonly StreamEvent[]) {
  return reduceTranscriptAll(initialTranscriptState(), events)
}

/** The call a log holds, or a failure that names what was there instead. */
function onlyCall(events: readonly StreamEvent[]) {
  const calls = selectToolCalls(reduce(events))
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('tool calls in the transcript (#303, #308)', () => {
  it('adds a call as its own entry, interleaved with the messages by position', () => {
    const user = makeUserMessage('fetch that', { seq: 1, processed_at: null })
    const call = makeAgentToolUse('web_fetch', { url: 'https://example.com' }, { seq: 2 })
    const result = makeAgentToolResult(call, 'the page', { seq: 3 })
    const reply = makeAgentMessage('It says hello.', { seq: 4 })

    const state = reduce([user, call, result, reply])

    expect(selectTranscriptEntries(state).map((entry) => entry.kind)).toEqual([
      'message',
      'tool',
      'message',
    ])
    expect(selectTranscriptEntries(state)[1]).toMatchObject({
      kind: 'tool',
      call: { name: 'web_fetch', position: 2 },
    })
  })

  it('derives the status from the result, the way the brain worded it', () => {
    const base = makeAgentToolUse('web_fetch', { url: 'https://example.com' })
    const call = { ...base, seq: 2 }

    expect(onlyCall([makeStatusRunning({ seq: 1 }), call]).status).toBe('running')

    expect(onlyCall([call, makeAgentToolResult(call, 'the page', { seq: 3 })]).status).toBe('done')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Tool web_fetch timed out', { seq: 3, is_error: true }),
      ]).status,
    ).toBe('error')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Permission to use web_fetch has been denied.', {
          seq: 3,
          is_error: true,
        }),
      ]).status,
    ).toBe('denied')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Interrupted by the user.', { seq: 3, is_error: true }),
      ]).status,
    ).toBe('interrupted')

    expect(
      onlyCall([
        call,
        makeAgentToolResult(call, 'Tool web_fetch: execution lost. …', { seq: 3, is_error: true }),
      ]).status,
    ).toBe('lost')
  })

  it('shows an `ask` policy as waiting for you, and keeps it waiting as the turn ends', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'https://x.test' },
      {
        seq: 2,
        evaluated_permission: 'ask',
      },
    )
    const idle = makeStatusIdle({
      seq: 3,
      stop_reason: { type: 'requires_action', event_ids: [call.id] },
    })

    const state = reduce([makeStatusRunning({ seq: 1 }), call, idle])

    expect(selectToolCalls(state)[0]?.status).toBe('waiting')
  })

  it('reports a call nothing answered when the turn ends as lost, not running', () => {
    const call = makeAgentToolUse('web_fetch', { url: 'https://x.test' }, { seq: 2 })
    const state = reduce([makeStatusRunning({ seq: 1 }), call, makeStatusIdle({ seq: 3 })])

    expect(selectToolCalls(state)[0]?.status).toBe('lost')
  })

  it('keeps a finished call done across the idle that ends the turn', () => {
    const call = makeAgentToolUse('echo', { text: 'hi' }, { seq: 2 })
    const state = reduce([
      makeStatusRunning({ seq: 1 }),
      call,
      makeAgentToolResult(call, 'hi', { seq: 3 }),
      makeStatusIdle({ seq: 4 }),
    ])

    expect(selectToolCalls(state)[0]?.status).toBe('done')
  })

  it('stamps the call’s source from the request’s own offered-tools record', () => {
    const start = makeModelRequestStart({
      seq: 1,
      tools: [
        { name: 'web_fetch', source: 'builtin' },
        { name: 'srv_search', source: 'mcp' },
      ],
    })
    const builtin = makeAgentToolUse('web_fetch', { url: 'https://x.test' }, { seq: 2 })
    const mcp = makeAgentToolUse('srv_search', { query: 'x' }, { seq: 3 })

    const calls = selectToolCalls(reduce([start, builtin, mcp]))

    expect(calls.map((call) => [call.name, call.source])).toEqual([
      ['web_fetch', 'builtin'],
      ['srv_search', 'mcp'],
    ])
  })

  it('defaults a call to builtin when no request record names it', () => {
    const call = makeAgentToolUse('echo', { text: 'hi' }, { seq: 2 })
    expect(selectToolCalls(reduce([call]))[0]?.source).toBe('builtin')
  })

  it('drops the calls a rewind took back, and keeps the ones before it', () => {
    const kept = makeAgentToolUse('echo', { text: 'kept' }, { seq: 2 })
    const rewind = makeSessionRewind({ seq: 6, supersedes: { from_seq: 4, to_seq: 5 } })
    const dropped = makeAgentToolUse('echo', { text: 'dropped' }, { seq: 4 })

    const state = reduce([
      makeUserMessage('one', { seq: 1, processed_at: null }),
      kept,
      makeAgentToolResult(kept, 'kept', { seq: 3 }),
      dropped,
      makeAgentMessage('reply', { seq: 5 }),
      rewind,
    ])

    expect(selectToolCalls(state).map((call) => call.id)).toEqual([kept.id])
  })

  it('records the tool results a request shortened and the old ones it cleared', () => {
    const start = makeModelRequestStart({
      seq: 1,
      truncated: {
        seq: 5,
        tokens_before: 12_000,
        tokens_after: 4_000,
        results: [{ seq: 5, tool: 'web_fetch', tokens_before: 12_000, tokens_after: 4_000 }],
      },
      cleared: { results: 2, tokens: 1800 },
    })

    const state = reduce([start])

    expect(selectTruncatedToolResults(state)).toEqual([
      { seq: 5, tool: 'web_fetch', tokensBefore: 12_000, tokensAfter: 4_000 },
    ])
    expect(selectClearedToolResults(state)).toEqual({ results: 2, tokens: 1800 })
  })

  it('clears both notices when the next real request capped and cleared nothing', () => {
    const first = makeModelRequestStart({
      seq: 1,
      truncated: { seq: 2, tokens_before: 100, tokens_after: 50 },
      cleared: { results: 1, tokens: 100 },
    })
    const next = makeModelRequestStart({ seq: 3 })

    const state = reduce([first, next])

    expect(selectTruncatedToolResults(state)).toEqual([])
    expect(selectClearedToolResults(state)).toBeNull()
  })

  it('drops the notices a rewind took back with the branch they described', () => {
    const start = makeModelRequestStart({
      seq: 4,
      cleared: { results: 1, tokens: 100 },
    })

    const state = reduce([
      start,
      makeSessionRewind({ seq: 9, supersedes: { from_seq: 3, to_seq: 8 } }),
    ])

    expect(selectClearedToolResults(state)).toBeNull()
  })

  it('ignores a result for a call the client never saw', () => {
    const orphan = makeAgentToolResult(makeAgentToolUse('echo', { text: 'x' }, { seq: 1 }), 'x', {
      id: newEventId(),
      tool_use_id: newEventId(),
      seq: 2,
    })

    expect(selectToolCalls(reduce([orphan]))).toEqual([])
  })

  it('is idempotent: folding the same call twice changes nothing', () => {
    const call = makeAgentToolUse('echo', { text: 'hi' }, { seq: 2 })
    // The same seq is dropped by the ordinary dedupe, so a re-delivered call adds no line.
    const state = reduce([call, call])

    expect(selectToolCalls(state)).toHaveLength(1)
  })
})

describe('MCP tool calls in the transcript (#312)', () => {
  it('folds an `agent.mcp_tool_use` into the same list, under its offered name and server', () => {
    const start = makeModelRequestStart({
      seq: 1,
      tools: [{ name: 'notes__search', source: 'mcp', server: 'notes' }],
    })
    const call = makeAgentMcpToolUse('notes', 'search', { query: 'doom' }, { seq: 2 })
    const result = makeAgentMcpToolResult(call, 'two notes', { seq: 3 })

    const calls = selectToolCalls(reduce([start, call, result]))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      // The event's id is the call's id, and the result names it in `mcp_tool_use_id`.
      id: call.id,
      // The model called it by the name it was offered under — the same spelling the settings
      // and the request's own `tools` record are keyed by.
      name: 'notes__search',
      source: 'mcp',
      server: 'notes',
      permission: 'ask',
      status: 'done',
      position: 2,
      result: { content: 'two notes', isError: false },
    })
  })

  it('pairs a result by `mcp_tool_use_id`, and drops one for a call it never saw', () => {
    const call = makeAgentMcpToolUse('notes', 'search', { query: 'x' }, { seq: 2 })
    const orphan = makeAgentMcpToolResult(
      makeAgentMcpToolUse('notes', 'search', { query: 'y' }, { seq: 5 }),
      'nobody asked',
      { id: newEventId(), mcp_tool_use_id: newEventId(), seq: 6 },
    )

    const state = reduce([call, orphan])

    expect(selectToolCalls(state).map((each) => each.id)).toEqual([call.id])
  })

  it('says `mcp` even when the client never saw the request that offered it', () => {
    const call = makeAgentMcpToolUse('notes', 'search', { query: 'x' }, { seq: 2 })
    // No `span.model_request_start` at all: the event's own type is what the call is read from.
    expect(onlyCall([call])).toMatchObject({ source: 'mcp', server: 'notes' })
  })

  it('reads a remote call as waiting for you, as its own `ask` default says', () => {
    const call = makeAgentMcpToolUse('notes', 'search', { query: 'x' }, { seq: 2 })
    const idle = makeStatusIdle({
      seq: 3,
      stop_reason: { type: 'requires_action', event_ids: [call.id] },
    })

    const state = reduce([makeStatusRunning({ seq: 1 }), call, idle])

    // A pause is a turn that ended on the question, so the line keeps waiting rather than
    // becoming `lost` — the same rule a policy-`ask` built-in call gets (#309).
    expect(selectToolCalls(state)[0]?.status).toBe('waiting')
  })

  it('reports a remote call nothing answered on a turn that ended as lost, when it may run', () => {
    const call = makeAgentMcpToolUse(
      'notes',
      'search',
      { query: 'x' },
      { seq: 2, evaluated_permission: 'allow' },
    )
    const state = reduce([makeStatusRunning({ seq: 1 }), call, makeStatusIdle({ seq: 3 })])

    expect(selectToolCalls(state)[0]?.status).toBe('lost')
  })

  it('interleaves an MCP call with the messages and a built-in call, by position', () => {
    const builtin = makeAgentToolUse('web_fetch', { url: 'https://x.test' }, { seq: 2 })
    const mcp = makeAgentMcpToolUse('notes', 'search', { query: 'x' }, { seq: 4 })

    const state = reduce([makeUserMessage('look', { seq: 1, processed_at: null }), builtin, mcp])

    expect(selectTranscriptEntries(state).map((entry) => entry.kind)).toEqual([
      'message',
      'tool',
      'tool',
    ])
    expect(state.toolCalls.map((call) => call.name)).toEqual(['web_fetch', 'notes__search'])
  })

  it('drops the MCP calls a rewind took back', () => {
    const kept = makeAgentMcpToolUse('notes', 'search', { query: 'kept' }, { seq: 2 })
    const dropped = makeAgentMcpToolUse('notes', 'search', { query: 'dropped' }, { seq: 4 })

    const state = reduce([
      kept,
      dropped,
      makeSessionRewind({ seq: 9, supersedes: { from_seq: 4, to_seq: 8 } }),
    ])

    expect(selectToolCalls(state).map((call) => call.id)).toEqual([kept.id])
  })

  it('keeps the pages a provider-executed search found, and the provider’s own source (#335)', () => {
    const call = makeAgentToolUse('web_search', { query: 'a' }, { seq: 2, source: 'provider' })
    const result = makeAgentToolResult(call, 'Web search results: 1. The architecture', {
      seq: 3,
      sources: [
        {
          url: 'https://example.test/architecture',
          title: 'The architecture',
          cited_text: 'three ideas carry the design',
        },
      ],
    })

    const [folded] = selectToolCalls(reduce([call, result]))

    // The line says where the tool came from — `provider`, read off the call — and the answer
    // carries the pages, which is what a frontend renders beside the query.
    expect(folded?.source).toBe('provider')
    expect(folded?.sources).toEqual([
      {
        url: 'https://example.test/architecture',
        title: 'The architecture',
        cited_text: 'three ideas carry the design',
      },
    ])
    // A call of this build's own answers with no sources at all, which is every other tool.
    const plain = makeAgentToolUse('web_fetch', { url: 'https://example.com' }, { seq: 4 })
    const [other] = selectToolCalls(
      reduce([plain, makeAgentToolResult(plain, 'The page says hello.', { seq: 5 })]),
    )
    expect(other?.sources).toBeUndefined()
  })

  it('counts a search by the model-facing name, so a remote `web_search` is not one', () => {
    const builtin = makeAgentToolUse('web_search', { query: 'a' }, { seq: 2 })
    const remote = makeAgentMcpToolUse('notes', 'web_search', { query: 'b' }, { seq: 3 })

    const state = reduce([builtin, remote])

    expect(selectSearchCount(state)).toBe(1)
  })
})

describe('the todo list in the transcript (#303, #305, #308)', () => {
  const todos = [
    { content: 'read the docs', status: 'done' as const },
    { content: 'write the code', status: 'in_progress' as const },
    { content: 'ship it', status: 'pending' as const },
  ]

  it('is null until a successful todo_write call takes effect', () => {
    expect(selectTodos(reduce([]))).toBeNull()

    const call = makeAgentToolUse('todo_write', { todos }, { seq: 2 })
    expect(selectTodos(reduce([call]))).toBeNull()

    const state = reduce([call, makeAgentToolResult(call, 'ok', { seq: 3 })])
    expect(selectTodos(state)).toEqual(todos)
  })

  it('takes the newest successful call, and reads an empty list as cleared', () => {
    const first = makeAgentToolUse('todo_write', { todos }, { seq: 2 })
    const cleared = makeAgentToolUse('todo_write', { todos: [] }, { seq: 5 })

    const state = reduce([
      first,
      makeAgentToolResult(first, 'ok', { seq: 3 }),
      cleared,
      makeAgentToolResult(cleared, 'ok', { seq: 6 }),
    ])

    expect(selectTodos(state)).toEqual([])
  })

  it('ignores a call that failed, and one nothing answered', () => {
    const failed = makeAgentToolUse('todo_write', { todos }, { seq: 2 })
    const unanswered = makeAgentToolUse('todo_write', { todos }, { seq: 5 })

    const state = reduce([
      failed,
      makeAgentToolResult(failed, 'Invalid input for todo_write', { seq: 3, is_error: true }),
      unanswered,
    ])

    expect(selectTodos(state)).toBeNull()
  })

  it('drops a list a rewind took back with the call that wrote it', () => {
    const call = makeAgentToolUse('todo_write', { todos }, { seq: 2 })
    const state = reduce([
      call,
      makeAgentToolResult(call, 'ok', { seq: 3 }),
      makeSessionRewind({ seq: 9, supersedes: { from_seq: 1, to_seq: 8 } }),
    ])

    expect(selectTodos(state)).toBeNull()
  })
})

describe('the reader’s decisions in the transcript (#303, #309; #310)', () => {
  it('keeps a confirmation and reads it back by the call it names', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const state = reduce([
      call,
      makeToolConfirmation(call, { seq: 3, remember: 'session' }),
      makeAgentToolResult(call, 'the page', { seq: 4 }),
    ])

    expect(selectConfirmation(state, call.id)).toMatchObject({
      toolUseId: call.id,
      result: 'allow',
      remember: 'session',
      seq: 3,
    })
    expect(selectConfirmations(state)).toHaveLength(1)
    expect(selectConfirmation(state, 'sevt_other')).toBeNull()
  })

  it('keeps what an answered question carried', () => {
    const call = makeAgentToolUse(
      'ask_user',
      { questions: [] },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const answers = [{ question: 'Which?', text: 'staging' }]
    const state = reduce([call, makeToolConfirmation(call, { seq: 3, answers })])

    expect(selectConfirmation(state, call.id)).toMatchObject({ answers, result: 'allow' })
  })

  it('reads a denial with the reader’s own words', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const state = reduce([
      call,
      makeToolConfirmation(call, { seq: 3, result: 'deny', deny_message: 'too risky' }),
      makeAgentToolResult(call, 'The user denied this: too risky', { seq: 4, is_error: true }),
    ])

    expect(selectConfirmation(state, call.id)).toMatchObject({
      result: 'deny',
      denyMessage: 'too risky',
    })
    expect(state.toolCalls[0]?.status).toBe('denied')
  })

  it('lets the newest decision about a call win', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const state = reduce([
      call,
      makeToolConfirmation(call, { seq: 3 }),
      makeToolConfirmation(call, { seq: 7, remember: 'always' }),
    ])

    expect(selectConfirmation(state, call.id)).toMatchObject({ remember: 'always', seq: 7 })
    expect(selectConfirmations(state)).toHaveLength(1)
  })

  it('drops a decision a rewind took back with the branch it was on', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const state = reduce([
      call,
      makeToolConfirmation(call, { seq: 3 }),
      makeSessionRewind({ seq: 9, supersedes: { from_seq: 1, to_seq: 8 } }),
    ])

    expect(selectConfirmations(state)).toEqual([])
  })

  it('keeps a decision the rewind did not reach', () => {
    const call = makeAgentToolUse(
      'web_fetch',
      { url: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const state = reduce([
      call,
      makeToolConfirmation(call, { seq: 3 }),
      makeSessionRewind({ seq: 9, supersedes: { from_seq: 8, to_seq: 8 } }),
    ])

    expect(selectConfirmations(state)).toHaveLength(1)
  })

  it('reads a call a message resolved as dismissed, not failed', () => {
    const call = makeAgentToolUse(
      'web_search',
      { query: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const result = makeAgentToolResult(call, 'The user sent a message instead.', {
      seq: 3,
      is_error: true,
    })

    expect(onlyCall([call, result]).status).toBe('dismissed')
  })
})

describe('an MCP failure the turn survived (#303, X10; #313)', () => {
  const FAILURE = 'The MCP server "notes" could not be used: it is down. This chat continues.'

  /** A log with one MCP failure and then whatever else. */
  const log = (...rest: readonly StreamEvent[]): readonly StreamEvent[] => [
    makeUserMessage('hello', { seq: 1 }),
    makeSessionError({
      seq: 2,
      error: {
        type: 'mcp_connection_failed_error',
        message: FAILURE,
        retry_status: { type: 'terminal' },
      },
    }),
    ...rest,
  ]

  it('keeps it rather than letting the reply that follows clear it', () => {
    const state = reduce(log(makeAgentMessage('Hi!', { seq: 3 }), makeStatusIdle({ seq: 4 })))

    // `lastError` is the turn's, and the turn recovered: the reply cleared it. The failure is
    // kept anyway, because a tool source that is missing is not a failed turn.
    expect(state.lastError).toBeNull()
    expect(selectMcpFailure(state)).toEqual({
      type: 'mcp_connection_failed_error',
      message: FAILURE,
      retryStatus: 'terminal',
      seq: 2,
    })
  })

  it('keeps the newest one, and only an MCP failure sets one', () => {
    const later = reduce(
      log(
        makeSessionError({
          seq: 5,
          error: {
            type: 'mcp_authentication_failed_error',
            message: 'The MCP server "git" could not be used: the token was refused.',
            retry_status: { type: 'terminal' },
          },
        }),
      ),
    )
    expect(selectMcpFailure(later)?.message).toContain('"git"')

    // An ordinary error leaves it exactly as it was.
    const other = reduce(
      log(
        makeSessionError({
          seq: 6,
          error: {
            type: 'tool_steps_exhausted_error',
            message: 'That was a lot of steps.',
            retry_status: { type: 'terminal' },
          },
        }),
      ),
    )
    expect(selectMcpFailure(other)?.type).toBe('mcp_connection_failed_error')
  })

  it('is nothing at all for a log with no MCP failure', () => {
    expect(
      selectMcpFailure(
        reduce([makeUserMessage('hello', { seq: 1 }), makeAgentMessage('Hi!', { seq: 2 })]),
      ),
    ).toBeNull()
  })

  it('goes with the branch a rewind takes back', () => {
    const covered = reduce(
      log(
        makeSessionRewind({ seq: 7, supersedes: { from_seq: 1, to_seq: 6 } }),
        makeUserMessage('hello again', { seq: 8 }),
      ),
    )
    expect(selectMcpFailure(covered)).toBeNull()

    // A rewind that does not reach it leaves the notice alone.
    const untouched = reduce(
      log(
        makeAgentMessage('Hi!', { seq: 3 }),
        makeUserMessage('more', { seq: 4 }),
        makeSessionRewind({ seq: 5, supersedes: { from_seq: 4, to_seq: 4 } }),
      ),
    )
    expect(selectMcpFailure(untouched)?.seq).toBe(2)
  })
})
