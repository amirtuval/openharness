import type { PendingCall, TranscriptToolCall } from '@openharness/client'
import type { AskUserQuestion } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Line } from '../markdown/text'
import type { TestInstance } from '../test-support/input'
import { frameOf, pressKey, tick, waitForScreen, typeText } from '../test-support/input'
import {
  PendingPromptView,
  pendingPromptHint,
  pendingPromptIdleHint,
  pendingPromptLines,
  pendingRows,
  type PendingDrafts,
} from './pending-prompt'
import { ThemeProvider } from './theme'

/**
 * The pending prompt: the approvals and questions waiting on the reader (epic #303, X6; #310).
 *
 * `pendingRows` and `pendingPromptLines` are the whole model — which rows there are, what they
 * say, what is marked — and the component is Ink drawing them while it owns the keys. The
 * events each row builds come from `@openharness/client` (tested there).
 */

const DARK = { background: 'dark', color: true, level: 3 } as const

/** The lines joined back into what a reader sees. */
function textOf(lines: readonly Line[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n')
}

/** A waiting approval call, as the transcript holds one. */
function approval(id = 'sevt_call', name = 'web_fetch'): TranscriptToolCall {
  return {
    id,
    name,
    input: { url: 'https://example.com' },
    permission: 'ask',
    source: 'builtin',
    status: 'waiting',
    position: 2,
  }
}

/** A waiting `ask_user` call. */
function question(id: string, questions: AskUserQuestion[]): TranscriptToolCall {
  return {
    id,
    name: 'ask_user',
    input: { questions },
    permission: 'ask',
    source: 'builtin',
    status: 'waiting',
    position: 3,
  }
}

const CHOICE: AskUserQuestion = {
  type: 'choice',
  question: 'Which environment?',
  header: 'Env',
  options: [{ label: 'staging' }, { label: 'production', description: 'the live one' }],
}

const CHECKS: AskUserQuestion = {
  type: 'choice',
  question: 'Which checks?',
  header: 'Checks',
  options: [{ label: 'tests' }, { label: 'lint' }],
  multi_select: true,
}

const TEXT: AskUserQuestion = {
  type: 'text',
  question: 'Anything else?',
  header: 'Notes',
  placeholder: 'optional',
}

const CONFIRM: AskUserQuestion = { type: 'confirm', question: 'Go ahead?', header: 'Go' }

const APPROVAL_ENTRY: PendingCall = { call: approval(), kind: 'approval', questions: [] }
const QUESTION_ENTRY: PendingCall = {
  call: question('sevt_ask', [CHOICE, CONFIRM]),
  kind: 'question',
  questions: [CHOICE, CONFIRM],
}

afterEach(() => {
  cleanup()
})

/** Press ↓ until the frame shows the row with the cursor on it. */
async function walkTo(instance: TestInstance, marker: string): Promise<void> {
  for (let step = 0; step < 24; step += 1) {
    if (frameOf(instance).includes(marker)) {
      return
    }
    pressKey(instance, 'down')
    await tick()
  }
  throw new Error(`the cursor never reached ${marker}. The frame was:\n${frameOf(instance)}`)
}

/** Render the list with a fresh drafts map, and wait for its keys to be live. */
async function show(
  entries: readonly PendingCall[],
  handlers: {
    onRespond?: (input: unknown) => void
    onText?: (options: { label: string; initial: string }) => Promise<string | null>
    onFocusComposer?: () => void
    active?: boolean
  } = {},
) {
  const onRespond = handlers.onRespond ?? ((): void => {})
  const onText = handlers.onText ?? ((): Promise<string | null> => Promise.resolve(null))
  const onFocusComposer = handlers.onFocusComposer ?? ((): void => {})
  const instance = render(
    <ThemeProvider theme={DARK}>
      <PendingPromptView
        entries={entries}
        active={handlers.active ?? true}
        onRespond={onRespond}
        onText={onText}
        onFocusComposer={onFocusComposer}
        width={80}
      />
    </ThemeProvider>,
  )
  await waitForScreen(instance, pendingPromptHint(entries).slice(0, 12))
  return instance as unknown as TestInstance
}

describe('pendingRows and the lines they draw (#310)', () => {
  it('offers an approval its four choices, and a message instead', () => {
    const rows = pendingRows([APPROVAL_ENTRY], {})
    expect(rows.map((row) => row.label)).toEqual([
      'Allow once',
      'Allow for this chat',
      'Always allow',
      'Deny',
      'Deny with a message…',
      'Write a message instead',
    ])
    expect(rows[0]?.choice).toBe('allow-once')
    expect(rows.at(-1)?.kind).toBe('message')
  })

  it('marks what is chosen, and names the question above its options', () => {
    const drafts: PendingDrafts = {
      sevt_ask: [
        { labels: ['production'], text: '', other: false, confirmed: null },
        { labels: [], text: '', other: false, confirmed: true },
      ],
    }
    const lines = pendingPromptLines([QUESTION_ENTRY], { drafts, cursorId: null }, 80, DARK)
    const text = textOf(lines)

    expect(text).toContain('Env · Which environment?')
    expect(text).toContain('● production')
    expect(text).toContain('○ staging')
    expect(text).toContain('the live one')
    expect(text).toContain('● Yes')
    expect(text).toContain('Go · Go ahead?')
    expect(text).toContain('Submit answers')
    expect(text).toContain('Decline')
  })

  it('says what is still missing from an unfinished answer', () => {
    const lines = pendingPromptLines([QUESTION_ENTRY], { drafts: {}, cursorId: null }, 80, DARK)
    expect(textOf(lines)).toContain('choose an option, or write an answer of your own')
  })

  it('shows a write-in and a text answer in their own rows', () => {
    const entry: PendingCall = {
      call: question('sevt_ask', [TEXT]),
      kind: 'question',
      questions: [TEXT],
    }
    const drafts: PendingDrafts = {
      sevt_ask: [{ labels: [], text: '', other: false, confirmed: null }],
    }
    expect(textOf(pendingPromptLines([entry], { drafts, cursorId: null }, 80, DARK))).toContain(
      'optional',
    )

    const answered: PendingDrafts = {
      sevt_ask: [{ labels: [], text: 'the release is Thursday', other: false, confirmed: null }],
    }
    expect(
      textOf(pendingPromptLines([entry], { drafts: answered, cursorId: null }, 80, DARK)),
    ).toContain('the release is Thursday')
  })

  it('draws the write-in row beside the options, marked when it is chosen', () => {
    const drafts: PendingDrafts = {
      sevt_ask: [{ labels: [], text: '', other: true, confirmed: null }],
    }
    const text = textOf(pendingPromptLines([QUESTION_ENTRY], { drafts, cursorId: null }, 80, DARK))
    expect(text).toContain('● Other')
  })

  it('truncates a row rather than overflowing a narrow terminal', () => {
    const entry: PendingCall = {
      call: question('sevt_ask', [CHOICE]),
      kind: 'question',
      questions: [CHOICE],
    }
    for (const line of pendingPromptLines([entry], { drafts: {}, cursorId: null }, 30, DARK)) {
      expect(line.reduce((width, span) => width + span.text.length, 0)).toBeLessThanOrEqual(29)
    }
  })

  it('says what the keys do, and what sending a message does', () => {
    expect(pendingPromptHint([APPROVAL_ENTRY])).toContain('1 item is waiting on you')
    expect(pendingPromptHint([APPROVAL_ENTRY])).toContain('Enter choose')
    expect(pendingPromptIdleHint([APPROVAL_ENTRY, QUESTION_ENTRY])).toContain(
      'sending a message will decline them',
    )
  })
})

describe('PendingPromptView, at the keyboard (#310)', () => {
  it('sends an approval when the highlighted row is taken', async () => {
    const onRespond = vi.fn()
    const instance = await show([APPROVAL_ENTRY], { onRespond })

    pressKey(instance, 'enter')
    expect(onRespond).toHaveBeenCalledWith([
      {
        type: 'user.tool_confirmation',
        tool_use_id: 'sevt_call',
        result: 'allow',
      },
    ])

    // ↓ moves to the next choice, which remembers the answer for this chat.
    pressKey(instance, 'down')
    await tick()
    pressKey(instance, 'enter')
    expect(onRespond).toHaveBeenLastCalledWith([
      expect.objectContaining({ result: 'allow', remember: 'session' }),
    ])
  })

  it('declines the call a row belongs to on Esc', async () => {
    const onRespond = vi.fn()
    const instance = await show([APPROVAL_ENTRY], { onRespond })

    pressKey(instance, 'escape')
    // A lone ESC is a byte Ink cannot place until the parser has looked ahead, so the key
    // lands a moment after it is written.
    await tick(50)
    expect(onRespond).toHaveBeenCalledWith([
      {
        type: 'user.tool_confirmation',
        tool_use_id: 'sevt_call',
        result: 'deny',
      },
    ])
  })

  it('chooses an option, toggles a multiple choice one, and submits', async () => {
    const entry: PendingCall = {
      call: question('sevt_ask', [CHECKS]),
      kind: 'question',
      questions: [CHECKS],
    }
    const onRespond = vi.fn()
    const instance = await show([entry], { onRespond })

    // The first row is the first option: space takes it, as the brief asks. `typeText` is how
    // a plain character is sent — `pressKey` is for named keys only.
    typeText(instance, ' ')
    await tick()
    expect(frameOf(instance)).toContain('● tests')

    pressKey(instance, 'down')
    await tick()
    typeText(instance, ' ')
    await tick()
    expect(frameOf(instance)).toContain('● lint')

    // Rows after the options: the write-in, then Submit. Down twice, and take it.
    pressKey(instance, 'down')
    await tick()
    pressKey(instance, 'down')
    await tick()
    pressKey(instance, 'enter')
    expect(onRespond).toHaveBeenCalledWith([
      expect.objectContaining({
        result: 'allow',
        answers: [{ question: CHECKS.question, labels: ['tests', 'lint'] }],
      }),
    ])
  })

  it('tab jumps to the next question rather than the next option', async () => {
    const instance = await show([QUESTION_ENTRY])

    // Rows: staging, production, Other, Yes, No, Submit, Decline, message. Tab from the first
    // option lands on the confirm's Yes.
    pressKey(instance, 'tab')
    await tick()
    // The tick above already proves Tab moved; what it moved to is the confirm's own question.
    expect(frameOf(instance)).toMatch(/▸ ○ Yes/u)
  })

  it('asks for a line of text when a text row is taken', async () => {
    const entry: PendingCall = {
      call: question('sevt_ask', [TEXT]),
      kind: 'question',
      questions: [TEXT],
    }
    const onText = vi.fn(() => Promise.resolve('the release is Thursday'))
    const instance = await show([entry], { onText })

    pressKey(instance, 'enter')
    await tick()
    expect(onText).toHaveBeenCalledWith({ label: TEXT.question, initial: '' })
  })

  it('answers several approvals together, one event per call', async () => {
    const second: PendingCall = {
      call: approval('sevt_two', 'web_search'),
      kind: 'approval',
      questions: [],
    }
    const onRespond = vi.fn()
    const instance = await show([APPROVAL_ENTRY, second], { onRespond })

    expect(frameOf(instance)).toContain('Allow all 2')
    expect(frameOf(instance)).toContain('Deny all 2')

    await walkTo(instance, '▸ · Deny all 2')
    pressKey(instance, 'enter')
    expect(onRespond).toHaveBeenCalledWith([
      { type: 'user.tool_confirmation', tool_use_id: 'sevt_call', result: 'deny' },
      { type: 'user.tool_confirmation', tool_use_id: 'sevt_two', result: 'deny' },
    ])
  })

  it('leaves a single approval to its own rows rather than a bulk one', async () => {
    const instance = await show([APPROVAL_ENTRY])
    expect(frameOf(instance)).not.toContain('Allow all 1')
  })

  it('hands the keyboard back when the reader would rather write a message', async () => {
    const onFocusComposer = vi.fn()
    const instance = await show([APPROVAL_ENTRY], { onFocusComposer })

    // The message row is last: the four choices, the deny-with-a-message row, then it.
    for (let step = 0; step < 5; step += 1) {
      pressKey(instance, 'down')
      await tick()
    }
    pressKey(instance, 'enter')
    expect(onFocusComposer).toHaveBeenCalled()
  })

  it('does not read keys when the message box has them', async () => {
    const onRespond = vi.fn()
    const instance = await show([APPROVAL_ENTRY], { onRespond, active: false })

    typeText(instance, 'hello')
    pressKey(instance, 'enter')
    pressKey(instance, 'escape')
    await tick()

    expect(onRespond).not.toHaveBeenCalled()
    expect(frameOf(instance)).toContain('sending a message will decline it')
    // No cursor either: the list is what is waiting, not something to answer from any more.
    expect(frameOf(instance)).not.toContain('▸')
  })
})
