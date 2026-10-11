import {
  APPROVAL_CHOICES,
  OTHER_CHOICE_LABEL,
  answerConfirmation,
  answersFrom,
  approvalChoiceLabel,
  approvalConfirmation,
  approvalConfirmations,
  declineConfirmation,
  draftComplete,
  draftProblems,
  emptyDrafts,
  withConfirmed,
  withLabel,
  withOther,
  withText,
  type ApprovalChoice,
  type PendingCall,
  type QuestionDraft,
} from '@openharness/client'
import type { AskUserQuestion, UserToolConfirmationEventInput } from '@openharness/protocol'
import { Box, Text, useInput, useStdout } from 'ink'
import { useRef, useState } from 'react'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, wrapSpans, type Line, type Span } from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * The pending prompt: the approvals and questions waiting on the reader, as a keyboard-driven
 * list (epic #303, X6; issue #310).
 *
 * The terminal's half of the web's approval prompt and `ask_user` form. A terminal has no
 * disclosure control and no pointer, so everything the two web components draw is one **flat
 * list of rows** here, walked with the arrows and answered with Enter — the wording, the
 * choices and the events they build all come from `@openharness/client`, so the page and `oh`
 * cannot disagree about what a reader is being asked.
 *
 * The keys, and the one deviation from the brief's list:
 *
 * | key            | what it does                                                             |
 * | -------------- | ------------------------------------------------------------------------ |
 * | ↑ / ↓          | move the cursor                                                          |
 * | Enter          | take the highlighted row — allow, choose, toggle, submit, decline        |
 * | Tab / Shift+Tab| jump to the next / previous question                                     |
 * | Esc            | decline the call the highlighted row belongs to                          |
 * | Space          | toggle a multiple-choice option                                          |
 *
 * **The space is why the list owns the keyboard.** The brief asks for space *and* for a message
 * that can be typed instead of answered, and a prompt cannot have both: a space typed into the
 * message would also be a keystroke the list reads. So while something is waiting the list
 * takes every key (`PromptInput`'s `captureKeys`), and the way to write a message instead is
 * the list's own last row — which hands the keyboard back. The composer then says what sending
 * one does (`pendingCallsNotice`), and one Enter beyond that sends it.
 *
 * Free text has no field to type into either, so a row that needs some — a `text` question, a
 * choice's write-in, a denial's message — opens the prompt slot's one-line input, the same
 * mechanism `/model` and `/providers` use. That is a flow of its own; the list comes back with
 * what it settled.
 */

/** What one row of the list is, and what taking it does. */
export type PendingRowKind =
  | 'approval'
  | 'option'
  | 'other'
  | 'text'
  | 'submit'
  | 'deny'
  | 'deny-message'
  | 'allow-all'
  | 'deny-all'
  | 'message'

/** One row of the pending prompt. */
export interface PendingRow {
  /** A stable key: the call, and what within it the row is. */
  readonly id: string
  /** The call this row answers — what Esc declines, and what an event names. */
  readonly callId: string
  /** What taking the row does. */
  readonly kind: PendingRowKind
  /** The row's own words. */
  readonly label: string
  /** What the row means, drawn dim beside it: an option's description, a question. */
  readonly detail?: string
  /** A line drawn above the row that opens a question or a call, when there is one. */
  readonly group?: string
  /** Whether the row is chosen — a picked option, a ticked checkbox, a filled-in field. */
  readonly selected?: boolean
  /** The question this row answers, for the ones that take a draft. */
  readonly question?: AskUserQuestion
  /** Which question of its call it is, for Tab's walk. */
  readonly questionIndex?: number
  /** What an approval row decides. */
  readonly choice?: ApprovalChoice
}

/** The drafts of every call in the list, keyed by the call's id. */
export type PendingDrafts = Readonly<Record<string, readonly QuestionDraft[]>>

/** The drafts every waiting call starts from: nothing said, one per question. */
export function initialDrafts(entries: readonly PendingCall[]): PendingDrafts {
  const drafts: Record<string, readonly QuestionDraft[]> = {}
  for (const entry of entries) {
    drafts[entry.call.id] = emptyDrafts(entry.questions)
  }
  return drafts
}

/**
 * Every row the list offers, in order (epic #303, #310).
 *
 * Pure, so a test can hold the whole keyboard model still without a terminal: an approval
 * contributes its choices, a question contributes one row per option (plus the write-in row the
 * type always allows), and each `ask_user` call ends with its Submit and Decline.
 */
export function pendingRows(
  entries: readonly PendingCall[],
  drafts: PendingDrafts,
): readonly PendingRow[] {
  const rows: PendingRow[] = []
  for (const entry of entries) {
    const callDrafts = drafts[entry.call.id] ?? []
    if (entry.kind === 'approval') {
      for (const choice of APPROVAL_CHOICES) {
        rows.push({
          id: `${entry.call.id}:${choice.choice}`,
          callId: entry.call.id,
          kind: 'approval',
          label: approvalChoiceLabel(choice.choice),
          group: `${entry.call.name} is waiting on you`,
          ...(choice.choice === 'deny'
            ? { detail: 'the model learns nothing but that you said no' }
            : {}),
          choice: choice.choice,
        })
      }
      rows.push({
        id: `${entry.call.id}:deny-message`,
        callId: entry.call.id,
        kind: 'deny-message',
        label: 'Deny with a message…',
      })
      continue
    }

    entry.questions.forEach((question, index) => {
      const draft = callDrafts[index] ?? emptyDrafts([question])[0]!
      const group = `${question.header} · ${question.question}`
      if (question.type === 'choice') {
        for (const option of question.options) {
          rows.push({
            id: `${entry.call.id}:${index}:${option.label}`,
            callId: entry.call.id,
            kind: 'option',
            label: option.label,
            ...(option.description === undefined ? {} : { detail: option.description }),
            group,
            selected: draft.labels.includes(option.label),
            question,
            questionIndex: index,
          })
        }
        rows.push({
          id: `${entry.call.id}:${index}:other`,
          callId: entry.call.id,
          kind: 'other',
          label: OTHER_CHOICE_LABEL,
          detail: draft.text === '' ? 'type your own answer' : draft.text,
          group,
          selected: draft.other,
          question,
          questionIndex: index,
        })
        return
      }
      if (question.type === 'confirm') {
        for (const answer of [true, false]) {
          rows.push({
            id: `${entry.call.id}:${index}:${String(answer)}`,
            callId: entry.call.id,
            kind: 'option',
            label: answer ? 'Yes' : 'No',
            group,
            selected: draft.confirmed === answer,
            question,
            questionIndex: index,
          })
        }
        return
      }
      rows.push({
        id: `${entry.call.id}:${index}:text`,
        callId: entry.call.id,
        kind: 'text',
        label: draft.text === '' ? (question.placeholder ?? 'type an answer') : draft.text,
        detail: draft.text === '' ? undefined : 'your answer',
        group,
        selected: draft.text !== '',
        question,
        questionIndex: index,
      })
    })

    rows.push({
      id: `${entry.call.id}:submit`,
      callId: entry.call.id,
      kind: 'submit',
      label: 'Submit answers',
      detail: submitHint(entry, callDrafts),
      group: `${entry.call.name} asked you ${entry.questions.length === 1 ? 'a question' : `${entry.questions.length} questions`}`,
    })
    rows.push({
      id: `${entry.call.id}:decline`,
      callId: entry.call.id,
      kind: 'deny',
      label: 'Decline',
      detail: 'the model is told you would not answer',
    })
  }
  // Several approvals are answerable together (epic #303, #310) — one event per call, in one
  // request — while a single one is left to its own rows: a bulk row for one call would be a
  // second copy of the same choice. A question never joins: `ask_user` cannot be allowed
  // without its answers.
  const approvals = entries.filter((entry) => entry.kind === 'approval')
  if (approvals.length > 1) {
    rows.push({
      id: 'allow-all',
      callId: approvals[0]!.call.id,
      kind: 'allow-all',
      label: `Allow all ${approvals.length}`,
      // The **once** approval for each: answering several at once must not hand out a
      // remembered permission nobody chose.
      detail: 'once each, for this call only',
    })
    rows.push({
      id: 'deny-all',
      callId: approvals[0]!.call.id,
      kind: 'deny-all',
      label: `Deny all ${approvals.length}`,
      detail: 'the model learns nothing but that you said no',
    })
  }
  if (entries.length > 0) {
    rows.push({
      id: 'message',
      callId: entries[0]!.call.id,
      kind: 'message',
      label: 'Write a message instead',
      detail: 'sending it declines everything waiting',
    })
  }
  return rows
}

/** What is still missing from a call's answers, for its Submit row — nothing when it is ready. */
function submitHint(entry: PendingCall, drafts: readonly QuestionDraft[]): string | undefined {
  if (draftComplete(entry.questions, drafts)) {
    return 'your answers are ready'
  }
  const [first] = draftProblems(entry.questions, drafts)
  return first ?? undefined
}

/** The line the list is drawn from, ready for the cursor: what is highlighted, and how wide. */
export interface PendingPromptState {
  /** The drafts of every waiting call. */
  readonly drafts: PendingDrafts
  /** The row the cursor is on, by id; `null` puts it on the first row. */
  readonly cursorId: string | null
}

/**
 * The lines the whole list is drawn from — the decision, in one place and without a terminal,
 * so a test can hold the words and the marks still (as `toolCallLines` and `todoLines` do).
 */
export function pendingPromptLines(
  entries: readonly PendingCall[],
  state: PendingPromptState,
  columns: number,
  theme: TerminalTheme,
): Line[] {
  const rows = pendingRows(entries, state.drafts)
  const width = Math.max(1, columns - CURSOR_COLUMNS)
  // `null` is "no cursor was set", which starts at the top — what a test that only wants the
  // words passes. An id that matches no row is "there is no cursor at all": the list is not what
  // is reading keys any more (the reader asked to write a message instead).
  const cursor = state.cursorId === null ? 0 : rows.findIndex((row) => row.id === state.cursorId)
  const lines: Line[] = []

  rows.forEach((row, index) => {
    const here = index === cursor
    if (row.group !== undefined && (index === 0 || rows[index - 1]?.group !== row.group)) {
      for (const line of wrapSpans(
        [{ text: row.group, color: paint(theme, PALETTE.chrome), dim: true }],
        width,
        'flow',
      )) {
        lines.push(line)
      }
    }
    const spans: Span[] = [
      { text: here ? '▸ ' : '  ', color: paint(theme, PALETTE.busy) },
      ...marked(row, theme),
      {
        text: row.label,
        bold: here,
        ...(row.selected === true ? { color: paint(theme, PALETTE.busy) } : {}),
      },
    ]
    if (row.detail !== undefined) {
      spans.push({ text: `  ${row.detail}`, color: paint(theme, PALETTE.chrome), dim: true })
    }
    lines.push(truncateSpans(spans, width))
  })
  return lines
}

/** The mark a row's own kind is drawn with: a tick, a ring, or nothing. */
function marked(row: PendingRow, theme: TerminalTheme): Span[] {
  if (row.kind === 'option' || row.kind === 'other') {
    return [
      {
        text: `${row.selected === true ? '●' : '○'} `,
        color: paint(theme, row.selected === true ? PALETTE.busy : PALETTE.chrome),
      },
    ]
  }
  if (row.kind === 'approval' || row.kind === 'submit' || row.kind === 'deny') {
    return [{ text: '· ', color: paint(theme, PALETTE.chrome), dim: true }]
  }
  if (row.kind === 'deny-message') {
    return [{ text: '· ', color: paint(theme, PALETTE.chrome), dim: true }]
  }
  return [{ text: '· ', color: paint(theme, PALETTE.chrome), dim: true }]
}

/** The line above the list that says what the keys do, and what sending a message does. */
export function pendingPromptHint(entries: readonly PendingCall[]): string {
  const howMany =
    entries.length === 1 ? '1 item is waiting on you' : `${entries.length} items are waiting on you`
  return `${howMany} · ↑/↓ move · Enter choose · Tab next question · Esc decline`
}

/**
 * The prompt the reader answers from (epic #303, #310).
 *
 * It renders the list and owns its keys. `onText` is how a row that needs free text asks for
 * it: the screen opens the prompt slot's one-line input and settles the string back, because a
 * terminal has no field the list could draw a cursor in.
 */
export function PendingPromptView({
  entries,
  active = true,
  onRespond,
  onText,
  onFocusComposer,
  width,
}: {
  readonly entries: readonly PendingCall[]
  /**
   * Whether the list reads keys, `true` by default.
   *
   * `false` is the reader having chosen "Write a message instead": the keyboard is the message
   * box's again, and the list is only what is still waiting. It comes back when the next pause
   * arrives.
   */
  readonly active?: boolean | undefined
  /**
   * Send one or more confirmations. The screen sends them and folds in what comes back; a bulk
   * row sends one event per call in one request, which is what "answer them together" means.
   */
  readonly onRespond: (events: readonly UserToolConfirmationEventInput[]) => void
  /** Ask for a line of text; the promise settles with it, or `null` when it was cancelled. */
  readonly onText: (options: {
    readonly label: string
    readonly initial: string
  }) => Promise<string | null>
  /** Hand the keyboard back to the message box — the list's "write a message instead". */
  readonly onFocusComposer: () => void
  /** How wide the terminal is, when the caller knows better than Ink does (the test seam). */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  // The drafts and the cursor, as a ref **and** a state: the ref is the value of record the
  // key handler reads, the state is what renders. Ink hands `useInput` a callback that sees the
  // latest committed render, and a terminal can deliver several keystrokes inside one — ↑ then
  // Enter arrives as two writes in one task — so a handler reading React state would move the
  // cursor and still take the row it was on before. The same rule, and the same reason, as
  // `prompt-input.tsx`'s buffer.
  const [drafts, setDraftsState] = useState<PendingDrafts>(() => initialDrafts(entries))
  const draftsRef = useRef<PendingDrafts>(drafts)
  const [cursorIndex, setCursorIndexState] = useState(0)
  const cursorRef = useRef(0)
  const columns = width ?? stdout.columns ?? 80

  const setDrafts = (next: PendingDrafts): void => {
    draftsRef.current = next
    setDraftsState(next)
  }
  const setCursorIndex = (next: number): void => {
    cursorRef.current = next
    setCursorIndexState(next)
  }

  const rows = pendingRows(entries, drafts)
  const index = Math.max(0, Math.min(cursorIndex, rows.length - 1))
  const row = rows[index]

  const setCallDrafts = (callId: string, next: readonly QuestionDraft[]): void => {
    setDrafts({ ...draftsRef.current, [callId]: next })
  }

  const draftFor = (target: PendingRow): readonly QuestionDraft[] => {
    const entry = entries.find((candidate) => candidate.call.id === target.callId)
    return (
      draftsRef.current[target.callId] ?? (entry === undefined ? [] : emptyDrafts(entry.questions))
    )
  }

  const replaceDraft = (target: PendingRow, next: QuestionDraft): void => {
    const current = draftFor(target)
    const at = target.questionIndex ?? 0
    setCallDrafts(
      target.callId,
      current.map((draft, position) => (position === at ? next : draft)),
    )
  }

  const take = (target: PendingRow | undefined): void => {
    if (target === undefined) return
    if (target.kind === 'approval' && target.choice !== undefined) {
      onRespond([approvalConfirmation(target.callId, target.choice)])
      return
    }
    if (target.kind === 'deny') {
      onRespond([declineConfirmation(target.callId)])
      return
    }
    if (target.kind === 'allow-all') {
      onRespond(
        approvalConfirmations(
          entries.filter((entry) => entry.kind === 'approval').map((entry) => entry.call),
          'allow-once',
        ),
      )
      return
    }
    if (target.kind === 'deny-all') {
      onRespond(
        approvalConfirmations(
          entries.filter((entry) => entry.kind === 'approval').map((entry) => entry.call),
          'deny',
        ),
      )
      return
    }
    if (target.kind === 'message') {
      onFocusComposer()
      return
    }
    if (target.kind === 'deny-message') {
      void onText({ label: 'Why not? (optional)', initial: '' }).then((message) => {
        if (message !== null) {
          onRespond([declineConfirmation(target.callId, message)])
        }
      })
      return
    }
    if (target.kind === 'submit') {
      const entry = entries.find((candidate) => candidate.call.id === target.callId)
      if (entry === undefined) return
      const callDrafts = draftFor(target)
      if (draftComplete(entry.questions, callDrafts)) {
        onRespond([answerConfirmation(target.callId, answersFrom(entry.questions, callDrafts))])
      }
      return
    }
    if (target.kind === 'option' && target.question !== undefined) {
      const question = target.question
      const draft = draftFor(target)[target.questionIndex ?? 0] ?? emptyDrafts([question])[0]!
      if (question.type === 'confirm') {
        replaceDraft(target, withConfirmed(draft, target.label === 'Yes'))
        return
      }
      if (question.type === 'choice') {
        replaceDraft(
          target,
          withLabel(draft, target.label, { multi: question.multi_select === true }),
        )
      }
      return
    }
    if (target.kind === 'other' && target.question !== undefined) {
      // The write-in: choose the row and take what the reader types, side by side with whatever
      // option they already picked — which is exactly what an answer carrying both means.
      const question = target.question
      const draft = draftFor(target)[target.questionIndex ?? 0] ?? emptyDrafts([question])[0]!
      void onText({ label: question.question, initial: draft.text }).then((text) => {
        if (text === null) return
        // A multiple-choice question lets the write-in sit beside what was picked; a
        // single-select one replaces the picked option, because an answer may carry one label.
        const multi = question.type === 'choice' && question.multi_select === true
        replaceDraft(
          target,
          multi
            ? withText(withOther(draft, true), text)
            : withText({ ...withOther(draft, true), labels: [] }, text),
        )
      })
      return
    }
    if (target.kind === 'text' && target.question !== undefined) {
      const question = target.question
      const draft = draftFor(target)[target.questionIndex ?? 0] ?? emptyDrafts([question])[0]!
      void onText({ label: question.question, initial: draft.text }).then((text) => {
        if (text !== null) {
          replaceDraft(target, withText(draft, text))
        }
      })
    }
  }

  /** The row Tab moves to: the first row of the next question (or call) after this one. */
  const jump = (step: 1 | -1): void => {
    const all = pendingRows(entries, draftsRef.current)
    const at = cursorRef.current
    const groupOf = (candidate: PendingRow): string => candidate.group ?? candidate.callId
    const current = all[at]
    const here = current === undefined ? '' : groupOf(current)
    // The next row that belongs to a **different** question — so Tab crosses a question rather
    // than walking its options one at a time — or the list's first (last) row when there is
    // none, which is how Tab wraps.
    const boundary =
      step > 0
        ? all.findIndex((candidate, position) => position > at && groupOf(candidate) !== here)
        : all.findLastIndex((candidate, position) => position < at && groupOf(candidate) !== here)
    setCursorIndex(boundary === -1 ? (step > 0 ? 0 : all.length - 1) : boundary)
  }

  useInput((input, key) => {
    if (!active) return
    // Every branch reads the **refs**, never the render's values: two keystrokes can arrive
    // inside one committed render, and the second must see what the first did.
    const all = pendingRows(entries, draftsRef.current)
    if (all.length === 0) return
    const at = Math.max(0, Math.min(cursorRef.current, all.length - 1))
    const current = all[at]

    if (key.upArrow) {
      return setCursorIndex(Math.max(0, at - 1))
    }
    if (key.downArrow) {
      return setCursorIndex(Math.min(all.length - 1, at + 1))
    }
    if (key.tab) {
      return jump(key.shift ? -1 : 1)
    }
    if (key.escape) {
      onRespond([declineConfirmation(current?.callId ?? all[0]!.callId)])
      return
    }
    if (input === ' ' || key.return) {
      return take(current)
    }
  })

  return (
    <Box flexDirection="column">
      <Text dimColor>{active ? pendingPromptHint(entries) : pendingPromptIdleHint(entries)}</Text>
      {pendingPromptLines(
        entries,
        // Without the keyboard there is no cursor: the list is what is waiting, not something
        // to answer from any more.
        { drafts, cursorId: active ? (row?.id ?? null) : '' },
        columns,
        theme,
      ).map((line, position) => (
        <Text key={position}>
          {line.map((span, at) => (
            <Text key={at} color={span.color} dimColor={span.dim} bold={span.bold}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

/** The line the list shows once the reader has asked to write a message instead. */
export function pendingPromptIdleHint(entries: readonly PendingCall[]): string {
  const howMany =
    entries.length === 1 ? '1 item is waiting on you' : `${entries.length} items are waiting on you`
  return `${howMany} · sending a message will decline ${entries.length === 1 ? 'it' : 'them'}`
}
