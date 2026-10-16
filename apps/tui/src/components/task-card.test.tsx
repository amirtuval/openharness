import { createTranscript, taskActivityOf } from '@openharness/client'
import type {
  ModelPriceLookup,
  SessionUsageTotals,
  TaskActivityLog,
  TaskActivityState,
  TaskCard,
  TaskCardStatus,
} from '@openharness/client'
import {
  makeAgentToolUse,
  makeSessionUsage,
  makeStatusIdle,
  makeStatusRunning,
} from '@openharness/protocol/fixtures'
import type { SessionId } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TerminalTheme } from '../markdown/theme'
import type { Line } from '../markdown/text'
import { TaskCardView, taskCardLines } from './task-card'
import { ThemeProvider } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true, level: 3 }
const PLAIN: TerminalTheme = { background: 'dark', color: false, level: 0 }

const CHILD_SESSION = 'sesn_child0000000000000000000' as SessionId

/** One card, with everything a test does not name left at its simplest. */
function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 'task_01',
    kind: 'subagent',
    childSessionId: CHILD_SESSION,
    type: 'researcher',
    description: 'Check the flaky test',
    status: 'running',
    messages: [],
    result: null,
    position: 3,
    ...overrides,
  }
}

/** A reading of a child, as `taskActivityOf` would have derived it. */
function activity(overrides: Partial<TaskActivityState> = {}): TaskActivityState {
  return {
    activity: { kind: 'idle' },
    waiting: false,
    status: 'idle',
    model: null,
    usage: null,
    cost: null,
    ...overrides,
  }
}

/** The lines as one string, one per line. */
function textOf(lines: readonly Line[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n')
}

/** What the card drew, mounted. */
function frameOf(component: ReactElement, theme: TerminalTheme = DARK): string {
  return (
    render(<ThemeProvider theme={theme}>{component}</ThemeProvider>).lastFrame() ?? ''
  ).trimEnd()
}

/** An async iterable over a fixed list, which is what a stored log's history read is. */
function asyncOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => {
      let index = 0
      return {
        next: () =>
          Promise.resolve(
            index < items.length
              ? { value: items[index++] as T, done: false }
              : { value: undefined, done: true },
          ),
      }
    },
  }
}

/** A log a card can follow: the events of one child session, and nothing live after them. */
function logOf(events: readonly unknown[]): TaskActivityLog {
  return {
    iterate: () => asyncOf(events) as AsyncIterable<never>,
    // Nothing after the history: a child whose log ended has nothing live to follow.
    stream: () => asyncOf([]) as AsyncIterable<never>,
  }
}

const PRICES: ModelPriceLookup = () => ({
  input: 3,
  output: 15,
  cache_read: null,
  cache_write: null,
})

afterEach(cleanup)

describe('taskCardLines (#340, S9; #347)', () => {
  it('opens with the status, the type and the description', () => {
    const lines = taskCardLines(card(), null, 80, DARK)
    expect(textOf(lines)).toBe('◐ running · researcher · Check the flaky test')
  })

  it('draws every status the card can be in', () => {
    const statuses: readonly [TaskCardStatus, string][] = [
      ['running', '◐ running'],
      ['waiting', '◔ waiting'],
      ['done', '● done'],
      ['failed', '✗ failed'],
      ['stopped', '⊘ stopped'],
    ]
    for (const [status, mark] of statuses) {
      const lines = taskCardLines(card({ status }), null, 80, DARK)
      expect(lines[0]?.map((span) => span.text).join('')).toContain(mark)
    }
  })

  it('colours the status: green done, busy running, red failed, grey stopped', () => {
    const color = (
      status: TaskCardStatus,
      live: TaskActivityState | null = null,
    ): string | undefined => taskCardLines(card({ status }), live, 80, DARK)[0]?.[0]?.color

    expect(color('done')).toBe('green')
    expect(color('running')).toBe('yellow')
    expect(color('failed')).toBe('red')
    expect(color('stopped')).toBe('gray')
    // Waiting is the child's own fact, and it is not the alarm a call waiting on the reader is.
    expect(color('running', activity({ waiting: true }))).toBe('cyan')
  })

  it('refines the parent’s running into waiting from the child’s own stream', () => {
    const lines = taskCardLines(card({ status: 'running' }), activity({ waiting: true }), 80, DARK)
    expect(textOf(lines)).toContain('◔ waiting')
  })

  it('draws the child’s activity line under the head', () => {
    const lines = taskCardLines(
      card(),
      activity({ activity: { kind: 'tool', name: 'web_fetch', summary: 'https://example.com' } }),
      80,
      DARK,
    )
    expect(textOf(lines)).toBe(
      ['◐ running · researcher · Check the flaky test', '  web_fetch: https://example.com'].join(
        '\n',
      ),
    )
  })

  it('draws a task list as a count and a writing child as writing…', () => {
    const todos = taskCardLines(
      card(),
      activity({ activity: { kind: 'todos', done: 2, total: 5 } }),
      80,
      DARK,
    )
    expect(textOf(todos)).toContain('2 of 5')

    const writing = taskCardLines(
      card(),
      activity({ activity: { kind: 'writing' }, status: 'running' }),
      80,
      DARK,
    )
    expect(textOf(writing)).toContain('writing…')
  })

  it('draws what the child has spent, and no cost without a catalog', () => {
    const usage: SessionUsageTotals = { input: 1200, output: 300, cacheCreation: 0, cacheRead: 0 }
    const lines = taskCardLines(
      card(),
      activity({
        usage,
        cost: { cost: 0.02, unpriced_requests: 0 },
      }),
      80,
      DARK,
    )
    expect(textOf(lines)).toContain('1.5k tokens · $0.02')

    // The same tokens with no catalog to price them: the tokens stay, the money does not.
    const unpriced = taskCardLines(card(), activity({ usage }), 80, DARK)
    expect(textOf(unpriced)).toContain('1.5k tokens')
    expect(textOf(unpriced)).not.toContain('$')
  })

  it('draws the conversation in both directions, in the order it happened', () => {
    const lines = taskCardLines(
      card({
        messages: [
          { from: 'parent', text: 'check the flaky test first', seq: 5 },
          { from: 'child', text: 'found it', seq: 7 },
        ],
      }),
      null,
      80,
      DARK,
    )
    expect(textOf(lines)).toBe(
      [
        '◐ running · researcher · Check the flaky test',
        '  → researcher: check the flaky test first',
        '  researcher →: found it',
      ].join('\n'),
    )
  })

  it('keeps the newest messages and counts the ones it leaves out', () => {
    const messages = [1, 2, 3, 4, 5].map((n) => ({
      from: 'child' as const,
      text: `note ${String(n)}`,
      seq: n,
    }))
    const lines = taskCardLines(card({ messages }), null, 80, DARK)
    expect(textOf(lines)).toContain('… 2 earlier')
    expect(textOf(lines)).toContain('note 3')
    expect(textOf(lines)).toContain('note 5')
    expect(textOf(lines)).not.toContain('note 2')
  })

  it('folds the result in under the conversation', () => {
    const lines = taskCardLines(
      card({
        status: 'done',
        result: { kind: 'result', text: 'One assertion was flaky.\nMore detail.', seq: 9 },
      }),
      null,
      80,
      DARK,
    )
    expect(textOf(lines)).toContain('⎿ One assertion was flaky.')
    // The rest of the result is the child's own chat, not a paragraph in the parent's.
    expect(textOf(lines)).not.toContain('More detail.')
  })

  it('truncates rather than overflowing a narrow terminal', () => {
    const lines = taskCardLines(
      card({ description: 'a description that is far too long for the width it is drawn in' }),
      null,
      40,
      DARK,
    )
    for (const line of lines) {
      expect(line.map((span) => span.text).join('').length).toBeLessThanOrEqual(39)
    }
  })

  it('says the same thing with no colour at all', () => {
    const live = activity({
      activity: { kind: 'tool', name: 'grep', summary: null },
      usage: { input: 10, output: 2, cacheCreation: 0, cacheRead: 0 },
    })
    expect(textOf(taskCardLines(card(), live, 80, PLAIN))).toBe(
      textOf(taskCardLines(card(), live, 80, DARK)),
    )
  })
})

describe('TaskCardView (#347)', () => {
  it('draws the card, with nothing live when it is not given a log', () => {
    const frame = frameOf(<TaskCardView card={card()} width={80} />)
    expect(frame).toContain('◐ running · researcher · Check the flaky test')
  })

  it('follows the child and draws its activity and its cost', async () => {
    // A child that is working: a turn open and a call out.
    const call = makeAgentToolUse('web_fetch', { url: 'https://example.com/docs' })
    const log = logOf([
      makeStatusRunning({ seq: 1 }),
      makeSessionUsage(
        [
          {
            model: 'anthropic/claude-sonnet-5',
            usage: {
              input_tokens: 1400,
              output_tokens: 200,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            requests: 1,
          },
        ],
        { seq: 2 },
      ),
      call,
    ])

    const view = render(
      <ThemeProvider theme={DARK}>
        <TaskCardView card={card()} log={log} prices={PRICES} width={80} />
      </ThemeProvider>,
    )

    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? ''
      if (!frame.includes('web_fetch: https://example.com/docs')) {
        throw new Error(`the card never followed its child. It was:\n${frame}`)
      }
    })
    expect(view.lastFrame() ?? '').toContain('1.6k tokens')
  })

  it('opens no stream for a card that has finished (#368)', () => {
    // A done, failed or stopped helper is doing nothing, so there is no activity line to draw and
    // no reason to hold an SSE connection — with the server's keepalive — open for as long as the
    // transcript holds the card. `taskIsLive` is the client's own rule, and the web card was
    // already passing it to its watcher; `oh`'s card opened one for every card, always.
    const log = { iterate: vi.fn(logOf([]).iterate), stream: vi.fn(logOf([]).stream) }
    const view = render(
      <ThemeProvider theme={DARK}>
        <TaskCardView
          card={card({ status: 'done', result: { text: 'One assertion was flaky.' } })}
          log={log}
          prices={PRICES}
          width={80}
        />
      </ThemeProvider>,
    )

    expect(view.lastFrame() ?? '').toContain('● done')
    expect(log.iterate).not.toHaveBeenCalled()
    expect(log.stream).not.toHaveBeenCalled()
  })

  it('closes the follower when the card goes away (#368)', async () => {
    // The other half of the same rule, and the one thing nothing pinned: `useTaskActivity`'s
    // `close()` is what drops the connection when a card leaves the screen, and the review found
    // no test that unmounted a card at all.
    const signals: AbortSignal[] = []
    const log: TaskActivityLog = {
      iterate: (_sessionId, _params, options) => {
        if (options?.signal !== undefined) signals.push(options.signal)
        return asyncOf([]) as AsyncIterable<never>
      },
      // Nothing live to follow, so the follower parks here — which is where a real one sits for a
      // child that is working and has not said anything new.
      stream: (_sessionId, options) => {
        if (options?.signal !== undefined) signals.push(options.signal)
        return asyncOf([]) as AsyncIterable<never>
      },
    }

    const view = render(
      <ThemeProvider theme={DARK}>
        <TaskCardView card={card({ status: 'running' })} log={log} width={80} />
      </ThemeProvider>,
    )

    await vi.waitFor(() => {
      if (signals.length === 0) {
        throw new Error('the card never followed its child')
      }
    })
    expect(signals.some((signal) => signal.aborted)).toBe(false)

    view.unmount()

    await vi.waitFor(() => {
      if (!signals.some((signal) => signal.aborted)) {
        throw new Error('the follower was left open when the card went away')
      }
    })
  })
})

describe('taskActivityOf’s reading of a child (#347)', () => {
  it('is what the card draws for a child whose log ended waiting on its own tasks', () => {
    const transcript = createTranscript()
    transcript.apply(
      makeStatusIdle({
        seq: 1,
        stop_reason: {
          type: 'waiting_on_tasks',
          task_ids: [],
          deadline: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const live = taskActivityOf(transcript.getState(), { waiting: true })
    expect(textOf(taskCardLines(card({ status: 'running' }), live, 80, DARK))).toContain(
      '◔ waiting',
    )
  })
})
