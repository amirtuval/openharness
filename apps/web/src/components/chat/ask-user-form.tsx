import {
  OTHER_CHOICE_LABEL,
  answerConfirmation,
  answersFrom,
  declineConfirmation,
  draftProblems,
  emptyDrafts,
  withConfirmed,
  withLabel,
  withOther,
  withText,
  type QuestionDraft,
  type TranscriptToolCall,
} from '@openharness/client'
import type { AskUserQuestion, UserToolConfirmationEventInput } from '@openharness/protocol'
import { MessageSquareQuote } from 'lucide-react'
import { useId, useState } from 'react'

import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

/**
 * The form for an `ask_user` call (epic #303, X6; issue #310).
 *
 * One to four questions, each with its header and its own control — a `choice` as radios (or
 * checkboxes when the call asks for several) with the options' descriptions beside them and an
 * **Other** row that takes the reader's own words, a `text` as an input, a `confirm` as a
 * yes/no pair. **Submit** sends every answer as one `user.tool_confirmation` carrying
 * `answers` — the answers *are* the call's result, because the tool never runs — and
 * **Decline** sends a denial, which is the one event that says "not answered" rather than
 * leaving the model to read silence.
 *
 * The rules the form enforces are the protocol's own ({@link draftProblems}, which is the same
 * `askUserAnswerProblems` the server refuses a 400 with): every question answered once, one
 * option at most where the question takes one, a write-in only where the question allows one.
 * Submit stays off until the drafts pass, and what is missing is named beside the questions —
 * so the reader is never told about a malformed answer by a failed request.
 *
 * The event it builds is one `user.tool_confirmation`; the **screen** sends it, because it
 * owns the request and the error it can fail with.
 */
export function AskUserForm({
  call,
  questions,
  busy,
  onRespond,
}: {
  call: TranscriptToolCall
  /** The call's parsed questions, in the order the model asked them. */
  questions: readonly AskUserQuestion[]
  /** A confirmation is in flight for this call: the controls are off until the log answers. */
  busy: boolean
  /** Send the reader's answer. The screen sends the event and folds in what comes back. */
  onRespond: (input: UserToolConfirmationEventInput) => void
}) {
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>(() => emptyDrafts(questions))
  const problems = draftProblems(questions, drafts)
  const ready = problems.length === 0

  const setDraft = (index: number, draft: QuestionDraft): void => {
    setDrafts((current) => current.map((existing, at) => (at === index ? draft : existing)))
  }

  return (
    <form
      data-slot="ask-user-form"
      data-questions={questions.length}
      aria-label={`Questions from ${call.name}`}
      className="mt-1 rounded-lg border border-coral/40 bg-coral/5 px-2.5 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) {
          onRespond(answerConfirmation(call.id, answersFrom(questions, drafts)))
        }
      }}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareQuote aria-hidden="true" className="size-3.5 shrink-0 text-coral-ink" />
        <span className="min-w-0">
          <span className="font-medium text-foreground">{call.name}</span> asked you{' '}
          {questions.length === 1 ? 'a question' : `${questions.length} questions`}.
        </span>
      </p>
      <div className="mt-2 space-y-3">
        {questions.map((question, index) => (
          <QuestionField
            key={question.question}
            question={question}
            draft={drafts[index] ?? emptyDrafts([question])[0]!}
            disabled={busy}
            onChange={(draft) => setDraft(index, draft)}
          />
        ))}
      </div>
      {problems.length === 0 ? null : (
        <ul data-slot="ask-user-problems" className="mt-2 space-y-0.5">
          {problems.map((problem) => (
            <li key={problem} className="text-2xs text-muted-foreground">
              {problem}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button type="submit" size="xs" disabled={busy || !ready}>
          Submit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="text-destructive"
          disabled={busy}
          onClick={() => onRespond(declineConfirmation(call.id))}
        >
          Decline
        </Button>
      </div>
    </form>
  )
}

/** One question: its header, its text, and the control its type asks for. */
function QuestionField({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: AskUserQuestion
  draft: QuestionDraft
  disabled: boolean
  onChange: (draft: QuestionDraft) => void
}) {
  // The question's own text is the group's name, and it is on screen already — a `legend` as
  // well would read it twice, so the fieldset points at the visible line instead.
  const labelId = useId()
  return (
    <fieldset
      data-slot="ask-user-question"
      data-type={question.type}
      aria-labelledby={labelId}
      className="min-w-0"
    >
      <div className="flex items-baseline gap-1.5">
        {/* The header is the short label a client puts above the question (#309 bounds it at
            twelve characters), so it reads as a chip rather than as the question itself. */}
        <Badge variant="outline" className="shrink-0 text-2xs">
          {question.header}
        </Badge>
        <span id={labelId} className="min-w-0 text-xs text-foreground">
          {question.question}
        </span>
      </div>
      <div className="mt-1 space-y-1">
        <QuestionControl
          question={question}
          draft={draft}
          disabled={disabled}
          onChange={onChange}
        />
      </div>
    </fieldset>
  )
}

/** The control a question's own type takes. */
function QuestionControl({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: AskUserQuestion
  draft: QuestionDraft
  disabled: boolean
  onChange: (draft: QuestionDraft) => void
}) {
  if (question.type === 'text') {
    return (
      <Input
        aria-label={question.question}
        value={draft.text}
        disabled={disabled}
        {...(question.placeholder === undefined ? {} : { placeholder: question.placeholder })}
        className="h-8 text-xs"
        onChange={(event) => onChange(withText(draft, event.target.value))}
      />
    )
  }

  if (question.type === 'confirm') {
    return (
      <div className="flex flex-wrap gap-1.5">
        <OptionRow
          kind="radio"
          name={question.question}
          checked={draft.confirmed === true}
          disabled={disabled}
          label="Yes"
          onSelect={() => onChange(withConfirmed(draft, true))}
        />
        <OptionRow
          kind="radio"
          name={question.question}
          checked={draft.confirmed === false}
          disabled={disabled}
          label="No"
          onSelect={() => onChange(withConfirmed(draft, false))}
        />
      </div>
    )
  }

  // A choice: the call's own options, then the "Other" row the type always allows — a user may
  // always answer in their own words, which is why a call does not have to list one.
  const kind = question.multi_select === true ? 'checkbox' : 'radio'
  return (
    <div className="space-y-1">
      {question.options.map((option) => (
        <OptionRow
          key={option.label}
          kind={kind}
          name={question.question}
          checked={draft.labels.includes(option.label)}
          disabled={disabled}
          label={option.label}
          {...(option.description === undefined ? {} : { description: option.description })}
          onSelect={() =>
            onChange(withLabel(draft, option.label, { multi: question.multi_select === true }))
          }
        />
      ))}
      <OptionRow
        kind={kind}
        name={question.question}
        checked={draft.other}
        disabled={disabled}
        label={OTHER_CHOICE_LABEL}
        {...(question.multi_select === true
          ? { onSelect: () => onChange(withOther(draft, !draft.other)) }
          : { onSelect: () => onChange({ ...withOther(draft, true), labels: [] }) })}
        extra={
          <Input
            aria-label={`Your own answer for “${question.question}”`}
            value={draft.text}
            disabled={disabled || !draft.other}
            placeholder="Your own answer"
            className="h-7 flex-1 text-xs"
            onChange={(event) => onChange(withText(draft, event.target.value))}
          />
        }
      />
    </div>
  )
}

/** One selectable row: a radio or a checkbox, its label, what it means, and anything beside it. */
function OptionRow({
  kind,
  name,
  checked,
  disabled,
  label,
  description,
  onSelect,
  extra,
}: {
  kind: 'radio' | 'checkbox'
  name: string
  checked: boolean
  disabled: boolean
  label: string
  description?: string | undefined
  onSelect: () => void
  /** An input drawn beside the label — the write-in row's own box. */
  extra?: React.ReactNode
}) {
  return (
    <label
      data-slot="ask-user-option"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1.5 text-xs',
        disabled ? 'opacity-60' : 'cursor-pointer',
      )}
    >
      <input
        type={kind}
        name={name}
        checked={checked}
        disabled={disabled}
        // The native control, so a keyboard reader and a screen reader both get the behaviour
        // they expect; the accent is the app's primary violet.
        className="size-3.5 shrink-0 accent-primary"
        onChange={onSelect}
      />
      <span className="shrink-0 text-foreground">{label}</span>
      {description === undefined ? null : (
        <span className="min-w-0 text-2xs text-muted-foreground">{description}</span>
      )}
      {extra}
    </label>
  )
}
