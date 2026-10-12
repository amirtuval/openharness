import type { StreamEvent } from '@openharness/protocol'
import type { FakeClient } from '@openharness/client/testing'
import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * A whole remote-MCP turn, streamed into the real chat screen (epic #303, X10; #312).
 *
 * The fake's brain cannot pause on a remote tool — it holds no MCP server to ask — so these
 * tests own the session's log instead: the fake's own history and stream are wrapped, and the
 * app folds in the events a real brain writes for a Linear call the reader allows. That is the
 * sequence manual staging produced the crash from, so it is the sequence a regression test has
 * to hold: `agent.mcp_tool_use` (the policy's `ask`, so the turn pauses) → the reader's
 * `user.tool_confirmation` → `agent.mcp_tool_result` carrying a large text + structured
 * content result → `agent.message`.
 *
 * The events are delivered **live and one at a time** — the SSE hook's own path, not a
 * pre-loaded log — because that is where the render loop lived.
 */

const MODEL = 'anthropic/claude-sonnet-5'
const CALL_ID = 'sevt_mcp0000000000000000000001'

/** The large answer a real MCP tool gives back: text plus structured content, as one blob. */
const BIG_RESULT = `{"issues":[${Array.from(
  { length: 60 },
  (_, index) =>
    `{"id":"LIN-${String(index + 1)}","title":"Issue ${String(index + 1)}","description":"${'lorem ipsum '.repeat(20)}"}`,
).join(',')}]}`

/** One stored event of the turn, with the fields the transcript reads. */
function event(seq: number, body: Record<string, unknown>): StreamEvent {
  return {
    id: `sevt_turn00000000000000000000${String(seq).padStart(2, '0')}`,
    seq,
    processed_at: '2026-10-12T00:00:00.000Z',
    ...body,
  } as unknown as StreamEvent
}

/**
 * The turn's log up to the pause: the message, the request that offered the Linear tools, the
 * call the policy evaluated `ask`, and the idle that ends the turn waiting on the reader.
 */
function opened(todos: boolean): StreamEvent[] {
  const events: StreamEvent[] = [
    event(1, {
      type: 'user.message',
      model: { id: MODEL },
      content: [{ type: 'text', text: 'File a Linear issue for the scroll bug' }],
    }),
    event(2, {
      type: 'span.model_request_start',
      model: MODEL,
      consumes: ['sevt_turn0000000000000000000001'],
      tools: [{ name: 'linear__create_issue', source: 'mcp', server: 'linear' }],
    }),
    event(3, {
      type: 'agent.mcp_tool_use',
      id: CALL_ID,
      mcp_server_name: 'linear',
      name: 'create_issue',
      input: { team: 'ENG', title: 'The chat crashes after an MCP call' },
      evaluated_permission: 'ask',
    }),
    event(4, {
      type: 'session.status_idle',
      stop_reason: { type: 'requires_action', event_ids: [CALL_ID] },
    }),
  ]
  if (todos) {
    // A task list the model wrote before it called the tool, so the side panel is drawn too.
    events.push(
      event(5, {
        type: 'agent.tool_use',
        id: 'sevt_todo0000000000000000000001',
        name: 'todo_write',
        input: {
          todos: [
            { content: 'Read the report', status: 'done' },
            { content: 'File the issue', status: 'in_progress' },
          ],
        },
        evaluated_permission: 'allow',
      }),
      event(6, {
        type: 'agent.tool_result',
        tool_use_id: 'sevt_todo0000000000000000000001',
        content: [{ type: 'text', text: 'ok' }],
        is_error: false,
      }),
    )
  }
  return events
}

/** What the reader's answer and the rest of the turn write, in the order the stream carries them. */
function rest(remember: 'once' | 'session' | 'always', from: number): StreamEvent[] {
  return [
    event(from, {
      type: 'user.tool_confirmation',
      tool_use_id: CALL_ID,
      result: 'allow',
      ...(remember === 'once' ? {} : { remember }),
    }),
    event(from + 1, { type: 'session.status_running' }),
    event(from + 2, {
      type: 'span.model_request_start',
      model: MODEL,
      consumes: [],
      tools: [{ name: 'linear__create_issue', source: 'mcp', server: 'linear' }],
    }),
    event(from + 3, {
      type: 'agent.mcp_tool_result',
      mcp_tool_use_id: CALL_ID,
      content: [{ type: 'text', text: BIG_RESULT }],
      is_error: false,
    }),
    event(from + 4, {
      type: 'agent.message',
      content: [{ type: 'text', text: 'Filed it as LIN-1.' }],
    }),
    event(from + 5, {
      type: 'span.model_request_end',
      model: MODEL,
      usage: {
        input_tokens: 1200,
        output_tokens: 40,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    event(from + 6, {
      type: 'session.status_idle',
      stop_reason: { type: 'end_turn' },
    }),
    event(from + 7, {
      type: 'session.usage',
      usage: {
        models: [
          {
            model: MODEL,
            requests: 1,
            input_tokens: 1200,
            output_tokens: 40,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      },
    }),
  ]
}

/**
 * A fake whose open session has a Linear call waiting on the reader.
 *
 * The history is delivered by `iterate` (the app's own load) and the rest by `stream`, held in
 * a gate the test releases one event at a time — the `test-support/stream.ts` rule, which this
 * test needs for its own script rather than the fake's.
 */
async function mcpTurn(
  options: { todos?: boolean; remember?: 'once' | 'session' | 'always' } = {},
) {
  const remember = options.remember ?? 'session'
  const fake: FakeClient = makeFake()
  const session = await fake.sessions.create({ model: { id: MODEL } })
  const past = opened(options.todos ?? false)
  const later = rest(remember, past.length + 1)

  const originalIterate = fake.sessions.events.iterate.bind(fake.sessions.events)
  fake.sessions.events.iterate = (sessionId, params, opts) => {
    const inner = originalIterate(sessionId, params, opts)
    return {
      async *[Symbol.asyncIterator]() {
        for await (const part of inner) {
          yield part
        }
        for (const part of past) {
          yield part
        }
      },
    } as unknown as ReturnType<FakeClient['sessions']['events']['iterate']>
  }

  const pending = [...later]
  let permits = 0
  let release: (() => void) | null = null
  const waited = async (signal: AbortSignal | undefined): Promise<void> => {
    if (permits > 0) {
      permits -= 1
      return
    }
    await new Promise<void>((resolve) => {
      release = resolve
    })
    if (signal?.aborted === true) {
      throw new DOMException('aborted', 'AbortError')
    }
    permits -= 1
  }
  fake.sessions.events.stream = (sessionId, opts) => {
    void sessionId
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          await waited(opts?.signal)
          const next = pending.shift()
          if (next === undefined) {
            return
          }
          yield next
        }
      },
    }
  }

  /** Release one event of the live stream and let React apply it. */
  const deliver = async (): Promise<void> => {
    await act(async () => {
      if (release !== null) {
        release()
        release = null
      } else {
        permits += 1
      }
      await Promise.resolve()
    })
  }

  return { fake, sessionId: session.id, deliver, remaining: () => pending.length + permits }
}

describe('a remote MCP turn in the chat (#303, #312)', () => {
  it('draws the paused call with its server named, and survives the whole turn', async () => {
    const { fake, sessionId, deliver } = await mcpTurn()
    renderApp(fake, { hash: `#/s/${sessionId}` })

    const prompt = await screen.findByRole('group', { name: /linear__create_issue/ })
    expect(prompt).toBeInTheDocument()
    expect(screen.getByText('waiting for you')).toBeInTheDocument()

    // The reader allows it, and the turn carries on with a large remote result and a reply.
    for (let step = 0; step < 8; step += 1) {
      await deliver()
    }

    await waitFor(() => {
      expect(screen.getByText('Filed it as LIN-1.')).toBeInTheDocument()
    })
    // The decision the log records is drawn on the call's row, and the result is behind its
    // disclosure rather than on the compact line.
    expect(await screen.findByText('Allowed for this chat')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /linear__create_issue/ })).toBeNull()
  })

  it('does the same with a task list beside it', async () => {
    const { fake, sessionId, deliver } = await mcpTurn({ todos: true })
    renderApp(fake, { hash: `#/s/${sessionId}` })

    expect(await screen.findByRole('group', { name: /linear__create_issue/ })).toBeInTheDocument()
    expect(document.querySelector('[data-slot="todo-panel"]')).not.toBeNull()

    for (let step = 0; step < 10; step += 1) {
      await deliver()
    }
    await waitFor(() => {
      expect(screen.getByText('Filed it as LIN-1.')).toBeInTheDocument()
    })
  })

  it('renders the answer a remembered approval carried', async () => {
    const { fake, sessionId, deliver } = await mcpTurn({ remember: 'always' })
    renderApp(fake, { hash: `#/s/${sessionId}` })

    for (let step = 0; step < 8; step += 1) {
      await deliver()
    }
    await waitFor(() => {
      expect(screen.getByText('Filed it as LIN-1.')).toBeInTheDocument()
    })
    expect(await screen.findByText('Always allowed')).toBeInTheDocument()
  })
})
