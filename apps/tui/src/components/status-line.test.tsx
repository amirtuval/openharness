import { makeModelEntry } from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { setImmediate as realSetImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TerminalTheme } from '../markdown/theme'
import {
  formatElapsed,
  InputRule,
  isQuiet,
  modelLabel,
  ruleSpan,
  ruleWidth,
  shortSessionId,
  SPINNER_FRAMES,
  statusField,
  statusSpans,
  StatusLine,
  WORKING_QUIET_MS,
  type StatusField,
  type StatusFieldInput,
  type StatusLineProps,
} from './status-line'
import { ThemeProvider } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true, level: 3 }
const PLAIN: TerminalTheme = { background: 'dark', color: false, level: 0 }

/** The session the line names; its ULID ends in the six characters the line shows. */
const SESSION = 'sesn_01M4BHNRMAG3T659PV1FQ092B1'

/** The line's props, with the ones a test does not care about filled in. */
function props(overrides: Partial<StatusLineProps> = {}): StatusLineProps {
  return {
    model: 'anthropic/claude-sonnet-5',
    sessionId: SESSION,
    status: 'idle',
    phase: 'ready',
    ...overrides,
  }
}

/** The line as the terminal would show it, at 100 columns unless a test says otherwise. */
function frameOf(overrides: Partial<StatusLineProps> = {}, width = 100): string {
  const { lastFrame } = render(
    <ThemeProvider theme={DARK}>
      <StatusLine {...props(overrides)} width={width} />
    </ThemeProvider>,
  )
  return lastFrame() ?? ''
}

/** The spans behind a frame, without Ink involved. */
function spansOf(
  overrides: Partial<StatusLineProps> = {},
  options: {
    readonly columns?: number
    readonly theme?: TerminalTheme
    readonly frame?: string
    readonly now?: number
  } = {},
) {
  const line = props(overrides)
  const field = statusField({
    phase: line.phase,
    status: line.status,
    runningSince: line.runningSince ?? null,
    lastTextAt: line.lastTextAt ?? null,
    retrying: line.retrying,
    interrupted: line.interrupted ?? false,
    now: options.now ?? 0,
  })
  return statusSpans(line, {
    field,
    frame: options.frame ?? '⠋',
    columns: options.columns ?? 100,
    theme: options.theme ?? DARK,
  })
}

/** The spans of a frame, joined back into the line a reader sees. */
function textOf(spans: readonly { readonly text: string }[]): string {
  return spans.map((span) => span.text).join('')
}

/**
 * Let React draw.
 *
 * A timer that fires is only half of it: the `setState` it causes is scheduled, and React's
 * scheduler wakes on a macrotask — a task source `advanceTimersByTimeAsync` does not drain,
 * because that is the whole point of it draining *fake* timers only. A real, unfaked
 * `setImmediate` is the turn of the event loop the frame is written in.
 */
async function flush(): Promise<void> {
  await realSetImmediate()
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('StatusLine', () => {
  it('draws the model, the session and the status, in that order', () => {
    expect(frameOf()).toBe('anthropic/claude-sonnet-5 · sesn_…Q092B1 · idle')
  })

  it('puts the mode in front of the model, which is what it resolved to (#245, M6)', () => {
    expect(frameOf({ mode: 'smart' })).toContain('smart · anthropic/claude-sonnet-5')
    expect(frameOf({ mode: 'smart', agentName: 'Summarizer' })).toContain(
      'smart · Summarizer · anthropic/claude-sonnet-5',
    )
  })

  it('puts the agent in front of the model when the session has one', () => {
    expect(frameOf({ agentName: 'Reviewer' })).toBe(
      'Reviewer · anthropic/claude-sonnet-5 · sesn_…Q092B1 · idle',
    )
  })

  it('says what a session is doing before its history has loaded', () => {
    expect(frameOf({ phase: 'loading', status: 'idle' })).toContain('loading history')
  })

  it('shows what the session has spent, between the session and the status (#247)', () => {
    // Where the money goes: a reader scanning the line finds the model, the chat, what it has
    // cost, and what it is doing — in that order.
    expect(frameOf({ cost: '$0.0013' })).toBe(
      'anthropic/claude-sonnet-5 · sesn_…Q092B1 · $0.0013 · idle',
    )
    // A model nobody prices reads `—`; a session that has not run, or a caller with no
    // catalog, passes nothing and the line has no cost at all.
    expect(frameOf({ cost: '—' })).toContain('· — · idle')
    expect(frameOf()).not.toContain('$')
  })

  it('names the unpriced requests, and shortens instead of dropping them when tight (#247)', () => {
    // A total that could not price every request carries the count beside the money.
    const wide = spansOf({ cost: '$0.0013 + 1 unpriced' }, { columns: 100 })
    expect(textOf(wide)).toContain('$0.0013 + 1 unpriced')

    // At 50 columns there is room for the money but not the words: the compact spelling stays
    // (`$0.0013+`), and the session handle — the line's least useful part — goes for it.
    const narrow = spansOf(
      { cost: '$0.0013 + 1 unpriced', costCompact: '$0.0013+' },
      { columns: 50 },
    )
    expect(textOf(narrow)).toContain('$0.0013+')
    expect(textOf(narrow)).not.toContain('unpriced')
    expect(textOf(narrow)).not.toContain('sesn_')
  })

  it('drops what the line is worth least when the terminal is too narrow', () => {
    const wide = spansOf({ cost: '$0.0013' }, { columns: 100 })
    expect(textOf(wide)).toContain('sesn_…Q092B1')
    expect(textOf(wide)).toContain('$0.0013')

    // 45 columns: the session handle goes first — it is the line's least useful part, and the
    // CLI prints the whole id on the way out — while what the chat costs stays.
    const narrow = spansOf({ cost: '$0.0013' }, { columns: 45 })
    expect(textOf(narrow)).toContain('$0.0013')
    expect(textOf(narrow)).toContain('idle')
    expect(textOf(narrow)).not.toContain('sesn_')

    // Narrower still: the money goes too, and the status — why the line exists — is what is
    // left.
    const tiniest = spansOf({ cost: '$0.0013' }, { columns: 30 })
    expect(textOf(tiniest)).not.toContain('$0.0013')
    expect(textOf(tiniest)).toContain('idle')
  })

  it('says nothing at all about a session id it cannot shorten', () => {
    expect(shortSessionId(SESSION)).toBe('sesn_…Q092B1')
    expect(shortSessionId('sesn_ABCDEF')).toBe('sesn_ABCDEF')
    expect(shortSessionId('not-a-session')).toBe('not-a-session')
  })
})

describe('the rule above the input area (issue #233)', () => {
  /** The rule as the terminal would show it, at 40 columns unless a test says otherwise. */
  function frame(overrides: { readonly width?: number; readonly blankAbove?: boolean } = {}) {
    const { lastFrame } = render(
      <ThemeProvider theme={DARK}>
        <InputRule width={overrides.width ?? 40} blankAbove={overrides.blankAbove ?? true} />
      </ThemeProvider>,
    )
    return lastFrame() ?? ''
  }

  it('spans the width, less the column the transcript reserves for its cursor', () => {
    // The last column is the streaming cursor's (`CURSOR_COLUMNS`), so the rule stops one
    // short of it and lines up with the transcript above.
    expect(ruleWidth(40)).toBe(39)
    expect(frame({ width: 40 })).toBe(`\n${'─'.repeat(39)}`)
  })

  it('is structure: the chrome named colour, and dim', () => {
    const span = ruleSpan(DARK, 40)
    expect(span.text).toBe('─'.repeat(39))
    expect(span.color).toBe('gray')
    expect(span.dim).toBe(true)
  })

  it('is the plain rule under NO_COLOR — a rule is a character, not a surface', () => {
    const span = ruleSpan(PLAIN, 40)
    expect(span.color).toBeUndefined()
    expect(span.text).toBe('─'.repeat(39))
    expect(frame({ width: 40 })).toContain('─'.repeat(39))
  })

  it('draws the blank line above itself only when it is asked for one', () => {
    // The screen asks for none when the band above already ended in one, or when there is
    // nothing above the section at all — a session's first frame.
    expect(frame({ blankAbove: true })).toBe(`\n${'─'.repeat(39)}`)
    expect(frame({ blankAbove: false })).toBe('─'.repeat(39))
  })

  it('never draws a rule with no room at all, however narrow the terminal is', () => {
    expect(ruleWidth(1)).toBe(1)
    expect(ruleWidth(0)).toBe(1)
  })
})

describe('modelLabel', () => {
  const catalog = [makeModelEntry({ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' })]

  it('uses the catalog name when the catalog knows the model', () => {
    expect(modelLabel('anthropic/claude-sonnet-5', catalog)).toBe('Claude Sonnet 5')
  })

  it('falls back to the id for a model the catalog has never heard of', () => {
    expect(modelLabel('meta/llama-4', catalog)).toBe('meta/llama-4')
    expect(modelLabel('anthropic/claude-sonnet-5', [])).toBe('anthropic/claude-sonnet-5')
  })
})

describe('statusField', () => {
  const base: Omit<StatusFieldInput, 'now'> = {
    phase: 'ready',
    status: 'idle',
    runningSince: null,
    lastTextAt: null,
    retrying: undefined,
    interrupted: false,
  }

  /** The field a set of values produces, on top of the quiet idle defaults. */
  function field(overrides: Partial<StatusFieldInput> = {}): StatusField {
    return statusField({ ...base, now: 0, ...overrides })
  }

  it('spins with the elapsed time while a turn has produced nothing', () => {
    expect(field({ status: 'running', runningSince: 1000, now: 13_000 })).toEqual({
      text: 'Working… 12s',
      spinner: true,
      tone: 'busy',
    })
  })

  it('stops spinning once a reply is producing text', () => {
    expect(field({ status: 'running', runningSince: 1000, lastTextAt: 4000, now: 5000 })).toEqual({
      text: 'running',
      spinner: false,
      tone: 'busy',
    })
  })

  it('spins again when the text stops arriving for a while', () => {
    const quiet = { status: 'running' as const, runningSince: 1000, lastTextAt: 4000 }
    expect(isQuiet(4000, 4000 + WORKING_QUIET_MS - 1)).toBe(false)
    expect(field({ ...quiet, now: 4000 + WORKING_QUIET_MS - 1 }).spinner).toBe(false)
    // …and the number beside it is the turn's age, not the length of the silence: the reader
    // is waiting on the turn, and `Working… 6s` is how long they have been waiting.
    expect(field({ ...quiet, now: 4000 + WORKING_QUIET_MS }).text).toBe('Working… 6s')
  })

  it('says the reason a retrying turn gave, and spins while the server does it', () => {
    const retrying = field({
      status: 'running',
      runningSince: 1000,
      lastTextAt: 2000,
      retrying: 'the model is overloaded',
      now: 3000,
    })
    expect(retrying).toEqual({
      text: 'Retrying… the model is overloaded',
      spinner: true,
      tone: 'busy',
    })
  })

  it('says a turn the user cut short, whatever came after it', () => {
    expect(
      field({
        status: 'running',
        runningSince: 1000,
        retrying: 'the model is overloaded',
        interrupted: true,
        now: 2000,
      }),
    ).toEqual({ text: 'Interrupted', spinner: false, tone: 'alarm' })
  })

  it('counts a turn that has run for over a minute in minutes', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(65_000)).toBe('1m 5s')
  })
})

describe('the working spinner', () => {
  it('turns on a timer, and shows the elapsed time as it goes', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const app = render(
      <ThemeProvider theme={DARK}>
        <StatusLine
          {...props({ status: 'running', runningSince: clock, lastTextAt: null })}
          width={100}
          now={() => clock}
        />
      </ThemeProvider>,
    )

    const first = app.lastFrame() ?? ''
    expect(first).toContain('Working… 0s')
    // One of the frames, not a particular one: which frame a tick lands on is the timer's
    // business, and a test that pinned it would be testing `setInterval`.
    expect(SPINNER_FRAMES.some((glyph) => first.includes(glyph))).toBe(true)

    clock += 12_000
    await vi.advanceTimersByTimeAsync(150)
    await flush()

    expect(app.lastFrame()).toContain('Working… 12s')

    const before = app.lastFrame()
    await vi.advanceTimersByTimeAsync(150)
    await flush()
    // …and it is turning: the glyph on screen is not the one that was there a tick ago.
    expect(app.lastFrame()).not.toBe(before)
  })

  it('stops ticking once the reply is streaming', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const app = render(
      <ThemeProvider theme={DARK}>
        <StatusLine
          {...props({ status: 'running', runningSince: clock, lastTextAt: clock })}
          width={100}
          now={() => clock}
        />
      </ThemeProvider>,
    )

    expect(app.lastFrame()).toContain('· running')

    clock += 5000
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    // Nothing to draw differently: the timer that wakes when the reply goes quiet is one
    // timeout away, and it has not been reached.
    expect(app.lastFrame()).toContain('· running')
  })

  it('comes back when the reply goes quiet for longer than the window', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const lastTextAt = clock
    const app = render(
      <ThemeProvider theme={DARK}>
        <StatusLine
          {...props({ status: 'running', runningSince: clock, lastTextAt })}
          width={100}
          now={() => clock}
        />
      </ThemeProvider>,
    )

    expect(app.lastFrame()).toContain('· running')

    clock += WORKING_QUIET_MS + 200
    await vi.advanceTimersByTimeAsync(WORKING_QUIET_MS + 200)
    await flush()

    // The reply has been silent for over three seconds, so the spinner is back — counting
    // the whole turn, which has been running for three and a bit.
    expect(app.lastFrame()).toContain('Working… 3s')
  })
})

describe('a narrow terminal', () => {
  const wide = props({ banner: 'fake client (dev)' })

  it('keeps everything when there is room for everything', () => {
    const text = textOf(spansOf(wide, { columns: 100 }))
    expect(text).toBe('anthropic/claude-sonnet-5 · sesn_…Q092B1 · idle · fake client (dev)')
  })

  it('drops the banner first', () => {
    const text = textOf(spansOf(wide, { columns: 50 }))
    expect(text).toBe('anthropic/claude-sonnet-5 · sesn_…Q092B1 · idle')
  })

  it('drops the session next, and the model after that', () => {
    expect(textOf(spansOf(wide, { columns: 40 }))).toBe('anthropic/claude-sonnet-5 · idle')
    expect(textOf(spansOf(wide, { columns: 20 }))).toBe('idle')
  })

  it('truncates rather than wrapping when even the status does not fit', () => {
    const text = textOf(spansOf(wide, { columns: 3 }))
    expect(text).toBe('id…')
  })

  it('counts the columns, not the characters, of what it keeps', () => {
    // The spinner is one column, and a double-width glyph would be two.
    const text = textOf(
      spansOf(
        { status: 'running', runningSince: 0, lastTextAt: null },
        { columns: 100, frame: '⠋', now: 0 },
      ),
    )
    expect(text).toBe('anthropic/claude-sonnet-5 · sesn_…Q092B1 · ⠋ Working… 0s')
  })
})

describe('colours (#201, X4)', () => {
  it('draws the chrome dim and in no colour of its own', () => {
    const spans = spansOf()
    expect(spans.every((span) => span.color === undefined)).toBe(true)
    expect(spans.every((span) => span.dim === true)).toBe(true)
  })

  it('draws a working turn in a named colour, not a dim one', () => {
    const spans = spansOf(
      { status: 'running', runningSince: 0, lastTextAt: null },
      { frame: '⠋', now: 0 },
    )
    const status = spans.find((span) => span.text.includes('Working…'))
    expect(status?.color).toBe('yellow')
    expect(status?.dim).toBe(false)
  })

  it('draws an interrupted turn in the alarm colour', () => {
    const spans = spansOf({ interrupted: true })
    const status = spans.find((span) => span.text === 'Interrupted')
    expect(status?.color).toBe('red')
    expect(status?.dim).toBe(false)
  })

  it('drops the colour entirely under NO_COLOR, and keeps the words', () => {
    const spans = spansOf(
      { status: 'running', runningSince: 0, lastTextAt: null },
      { theme: PLAIN, frame: '⠋', now: 0 },
    )
    expect(spans.every((span) => span.color === undefined)).toBe(true)
    expect(textOf(spans)).toContain('Working… 0s')
  })
})
