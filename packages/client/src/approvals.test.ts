import { describe, expect, it } from 'vitest'

import { ASK_USER_TOOL_NAME } from '@openharness/protocol'
import {
  makeAgentMcpToolUse,
  makeAgentToolResult,
  makeAgentToolUse,
  makeStatusIdle,
  makeStatusRunning,
} from '@openharness/protocol/fixtures'
import type { AskUserQuestion, StreamEvent } from '@openharness/protocol'

import {
  APPROVAL_CHOICES,
  OTHER_CHOICE_LABEL,
  answerConfirmation,
  answersFrom,
  approvalChoiceLabel,
  approvalConfirmation,
  approvalConfirmations,
  askUserQuestions,
  confirmationSummary,
  declineConfirmation,
  draftComplete,
  draftProblems,
  emptyDraft,
  emptyDrafts,
  pendingCallHeading,
  pendingCallKind,
  pendingCalls,
  pendingCallsNotice,
  withConfirmed,
  withLabel,
  withOther,
  withText,
} from './approvals'
import { initialTranscriptState, reduceTranscriptAll, selectToolCalls } from './transcript'

/** The calls a folded log holds, so a test drives real transcript shapes rather than literals. */
function callsOf(events: readonly StreamEvent[]) {
  return selectToolCalls(reduceTranscriptAll(initialTranscriptState(), events))
}

const CHOICE_QUESTION: AskUserQuestion = {
  type: 'choice',
  question: 'Which environment should I deploy to?',
  header: 'Environment',
  options: [{ label: 'staging' }, { label: 'production', description: 'the live one' }],
}

const MULTI_QUESTION: AskUserQuestion = {
  type: 'choice',
  question: 'Which checks?',
  header: 'Checks',
  options: [{ label: 'tests' }, { label: 'lint' }],
  multi_select: true,
}

const TEXT_QUESTION: AskUserQuestion = {
  type: 'text',
  question: 'Anything else?',
  header: 'Notes',
  placeholder: 'optional',
}

const CONFIRM_QUESTION: AskUserQuestion = {
  type: 'confirm',
  question: 'Include the changelog?',
  header: 'Changelog',
}

const ASK_INPUT = {
  questions: [CHOICE_QUESTION, TEXT_QUESTION, CONFIRM_QUESTION],
}

describe('pendingCalls (#303, #310)', () => {
  it('picks out the calls waiting on the reader, in order', () => {
    const allowed = makeAgentToolUse('web_fetch', { url: 'https://a.example' }, { seq: 1 })
    const asked = makeAgentToolUse(
      'web_search',
      { query: 'x' },
      { seq: 2, evaluated_permission: 'ask' },
    )
    const questioned = makeAgentToolUse(ASK_USER_TOOL_NAME, ASK_INPUT, {
      seq: 3,
      evaluated_permission: 'ask',
    })
    const running = makeAgentToolUse('web_fetch', { url: 'https://b.example' }, { seq: 4 })

    const calls = callsOf([
      makeStatusRunning({ seq: 0 }),
      allowed,
      asked,
      questioned,
      running,
    ] as StreamEvent[])

    const pending = pendingCalls(calls)
    expect(pending.map((entry) => entry.call.id)).toEqual([asked.id, questioned.id])
    expect(pending.map((entry) => entry.kind)).toEqual(['approval', 'question'])
    expect(pending[1]?.questions).toEqual(ASK_INPUT.questions)
    expect(pending[0]?.questions).toEqual([])
  })

  it('stops counting a call once a result has answered it', () => {
    const asked = makeAgentToolUse(
      'web_search',
      { query: 'x' },
      { seq: 1, evaluated_permission: 'ask' },
    )
    const result = makeAgentToolResult(asked, 'ok', { seq: 2 })

    expect(pendingCalls(callsOf([asked, result]))).toHaveLength(0)
  })

  it('reads the kind off the tool’s name', () => {
    const approval = callsOf([
      makeAgentToolUse('web_fetch', {}, { seq: 1, evaluated_permission: 'ask' }),
    ])[0]!
    const question = callsOf([
      makeAgentToolUse(ASK_USER_TOOL_NAME, ASK_INPUT, { seq: 1, evaluated_permission: 'ask' }),
    ])[0]!

    expect(pendingCallKind(approval)).toBe('approval')
    expect(pendingCallKind(question)).toBe('question')
    expect(pendingCallKind({ ...approval, status: 'done' })).toBeNull()
  })

  it('answers no questions for a call that is not ask_user', () => {
    const call = callsOf([makeAgentToolUse('web_fetch', { url: 'x' }, { seq: 1 })])[0]!
    expect(askUserQuestions(call)).toBeNull()
  })

  it('answers no questions for an ask_user call whose input is malformed', () => {
    const call = callsOf([
      makeAgentToolUse(
        ASK_USER_TOOL_NAME,
        { questions: [] },
        { seq: 1, evaluated_permission: 'ask' },
      ),
    ])[0]!
    expect(askUserQuestions(call)).toBeNull()
  })
})

describe('a pause on a remote MCP call (#303, X6; #312)', () => {
  it('reads a waiting `agent.mcp_tool_use` as an approval, and names its own id', () => {
    const call = makeAgentMcpToolUse('notes', 'search', { query: 'doom' }, { seq: 2 })

    const pending = pendingCalls(callsOf([makeStatusRunning({ seq: 1 }), call]))

    expect(pending).toHaveLength(1)
    expect(pending[0]?.kind).toBe('approval')
    expect(pending[0]?.call.id).toBe(call.id)
    // The confirmation names the call's **event** id — the MCP pair's `agent.mcp_tool_use` —
    // which is what the server checks against the log before it stores one, and what the brain
    // answers with an `agent.mcp_tool_result`.
    expect(approvalConfirmation(pending[0]!.call.id, 'allow-once')).toMatchObject({
      type: 'user.tool_confirmation',
      tool_use_id: call.id,
      result: 'allow',
    })
    expect(declineConfirmation(pending[0]!.call.id).tool_use_id).toBe(call.id)
  })

  it('asks no questions of a remote call, and heads the prompt with its server', () => {
    const call = callsOf([
      makeAgentMcpToolUse('notes', 'search', { query: 'doom' }, { seq: 2 }),
    ])[0]!

    expect(askUserQuestions(call)).toBeNull()
    expect(pendingCallHeading(call)).toBe('notes__search (mcp: notes)')
  })

  it('reads a remote tool called `ask_user` as an approval, not a question', () => {
    // The question is the built-in's **own** name; a server's tool of that name is offered as
    // `<server>__ask_user`, so a question is not something a remote server can forge (#312).
    const call = callsOf([
      makeAgentMcpToolUse('notes', ASK_USER_TOOL_NAME, { questions: [] }, { seq: 2 }),
    ])[0]!

    expect(pendingCallKind(call)).toBe('approval')
    expect(pendingCallHeading(call)).toBe('notes__ask_user (mcp: notes)')
  })

  it('heads a built-in call with its own name alone', () => {
    const call = callsOf([
      makeAgentToolUse('web_fetch', { url: 'x' }, { seq: 2, evaluated_permission: 'ask' }),
    ])[0]!

    expect(pendingCallHeading(call)).toBe('web_fetch')
  })
})

describe('approvalConfirmations (#303, #310)', () => {
  it('offers the four choices in the safe-first order', () => {
    expect(APPROVAL_CHOICES.map((entry) => entry.choice)).toEqual([
      'allow-once',
      'allow-session',
      'allow-always',
      'deny',
    ])
    expect(approvalChoiceLabel('allow-session')).toBe('Allow for this chat')
  })

  it('sends no remember for a one-off approval', () => {
    expect(approvalConfirmation('sevt_1', 'allow-once')).toEqual({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_1',
      result: 'allow',
    })
  })

  it('sends the remember extension for the two remembered approvals', () => {
    expect(approvalConfirmation('sevt_1', 'allow-session')).toMatchObject({ remember: 'session' })
    expect(approvalConfirmation('sevt_1', 'allow-always')).toMatchObject({ remember: 'always' })
  })

  it('carries the reader’s own words on a denial, and drops a blank one', () => {
    expect(declineConfirmation('sevt_1', '  too risky  ')).toEqual({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_1',
      result: 'deny',
      deny_message: 'too risky',
    })
    expect(declineConfirmation('sevt_1', '   ')).toEqual({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_1',
      result: 'deny',
    })
  })

  it('answers a batch one event per call, in order', () => {
    const a = callsOf([
      makeAgentToolUse('web_fetch', {}, { seq: 1, evaluated_permission: 'ask' }),
      makeAgentToolUse('web_search', {}, { seq: 2, evaluated_permission: 'ask' }),
    ])

    const events = approvalConfirmations(a, 'allow-always')
    expect(events.map((event) => event.tool_use_id)).toEqual([a[0]!.id, a[1]!.id])
    expect(events.every((event) => event.remember === 'always')).toBe(true)
  })

  it('sends a question’s answers as an approval carrying them', () => {
    expect(
      answerConfirmation('sevt_1', [{ question: TEXT_QUESTION.question, text: 'nothing' }]),
    ).toEqual({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_1',
      result: 'allow',
      answers: [{ question: TEXT_QUESTION.question, text: 'nothing' }],
    })
  })
})

describe('the ask_user form’s drafts (#303, #310)', () => {
  const questions = [CHOICE_QUESTION, TEXT_QUESTION, CONFIRM_QUESTION]

  it('starts with nothing said', () => {
    expect(emptyDrafts(questions)).toEqual([emptyDraft(), emptyDraft(), emptyDraft()])
  })

  it('takes one option at a time on a single-select question', () => {
    const first = withLabel(emptyDraft(), 'staging', { multi: false })
    expect(first.labels).toEqual(['staging'])
    expect(withLabel(first, 'production', { multi: false }).labels).toEqual(['production'])
  })

  it('toggles on a multi-select question', () => {
    const both = withLabel(withLabel(emptyDraft(), 'tests', { multi: true }), 'lint', {
      multi: true,
    })
    expect(both.labels).toEqual(['tests', 'lint'])
    expect(withLabel(both, 'tests', { multi: true }).labels).toEqual(['lint'])
  })

  it('builds the answers the wire takes, leaving out what a question cannot carry', () => {
    const drafts = [
      withText(
        withOther(withLabel(emptyDraft(), 'staging', { multi: false }), true),
        '  eu-west-1  ',
      ),
      withText(emptyDraft(), 'the release is on Thursday'),
      withConfirmed(emptyDraft(), false),
    ]

    expect(answersFrom(questions, drafts)).toEqual([
      { question: CHOICE_QUESTION.question, labels: ['staging'], text: 'eu-west-1' },
      { question: TEXT_QUESTION.question, text: 'the release is on Thursday' },
      { question: CONFIRM_QUESTION.question, confirmed: false },
    ])
  })

  it('writes in with no label when the reader chose nothing else', () => {
    const drafts = [
      withText(withOther(emptyDraft(), true), 'eu-west-1'),
      withText(emptyDraft(), 'x'),
      withConfirmed(emptyDraft(), true),
    ]
    expect(answersFrom(questions, drafts)[0]).toEqual({
      question: CHOICE_QUESTION.question,
      text: 'eu-west-1',
    })
  })

  it('reports every question until each is answered, with the header', () => {
    const empty = emptyDrafts(questions)
    expect(draftComplete(questions, empty)).toBe(false)
    expect(draftProblems(questions, empty)).toEqual([
      `${CHOICE_QUESTION.header}: choose an option, or write an answer of your own`,
      `${TEXT_QUESTION.header}: a text question needs \`text\``,
      `${CONFIRM_QUESTION.header}: a yes/no question needs \`confirmed\``,
    ])
  })

  it('is complete once every question is answered', () => {
    const drafts = [
      withLabel(emptyDraft(), 'production', { multi: false }),
      withText(emptyDraft(), 'nothing'),
      withConfirmed(emptyDraft(), true),
    ]
    expect(draftProblems(questions, drafts)).toEqual([])
    expect(draftComplete(questions, drafts)).toBe(true)
  })

  it('refuses two options on a question that takes one', () => {
    const drafts = [
      { ...emptyDraft(), labels: ['staging', 'production'] },
      withText(emptyDraft(), 'x'),
      withConfirmed(emptyDraft(), true),
    ]
    expect(draftComplete(questions, drafts)).toBe(false)
    expect(draftProblems(questions, drafts)[0]).toContain('takes one option')
  })

  it('takes several on a multi_select question', () => {
    const multi = [MULTI_QUESTION]
    expect(draftComplete(multi, [{ ...emptyDraft(), labels: ['tests', 'lint'] }])).toBe(true)
  })

  it('does not let a write-in label smuggle in an unoffered option', () => {
    const drafts = [
      { ...emptyDraft(), labels: ['not-an-option'] },
      withText(emptyDraft(), 'x'),
      withConfirmed(emptyDraft(), true),
    ]
    expect(draftProblems(questions, drafts)[0]).toContain('is not an option this question offers')
  })

  it('names the write-in row once, so both forms draw the same one', () => {
    expect(OTHER_CHOICE_LABEL).toBe('Other')
  })
})

describe('confirmationSummary (#303, #310)', () => {
  it('says how a call came to run', () => {
    expect(confirmationSummary({ result: 'allow' })).toBe('Allowed once')
    expect(confirmationSummary({ result: 'allow', remember: 'once' })).toBe('Allowed once')
    expect(confirmationSummary({ result: 'allow', remember: 'session' })).toBe(
      'Allowed for this chat',
    )
    expect(confirmationSummary({ result: 'allow', remember: 'always' })).toBe('Always allowed')
  })

  it('draws nothing for a denial or an answered question, whose own line says it', () => {
    expect(confirmationSummary({ result: 'deny' })).toBeNull()
    expect(
      confirmationSummary({
        result: 'allow',
        answers: [{ question: TEXT_QUESTION.question, text: 'x' }],
      }),
    ).toBeNull()
  })
})

describe('pendingCallsNotice (#303, #310)', () => {
  it('counts the items a message would decline', () => {
    expect(pendingCallsNotice(0)).toBeNull()
    expect(pendingCallsNotice(1)).toBe('Sending a message will decline the item waiting on you.')
    expect(pendingCallsNotice(2)).toBe('Sending a message will decline the 2 items waiting on you.')
  })
})

describe('a pause and the idle that ends the turn (#303, #309; #310)', () => {
  it('keeps a call waiting across the idle that names it', () => {
    const asked = makeAgentToolUse(
      'web_search',
      { query: 'x' },
      { seq: 1, evaluated_permission: 'ask' },
    )
    const idle = makeStatusIdle({
      seq: 2,
      stop_reason: { type: 'requires_action', event_ids: [asked.id] },
    })

    const pending = pendingCalls(callsOf([asked, idle]))
    expect(pending).toHaveLength(1)
    expect(pending[0]?.call.status).toBe('waiting')
  })
})
