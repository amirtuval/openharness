import type { TranscriptToolCall } from '@openharness/client'
import type { AskUserQuestion } from '@openharness/protocol'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AskUserForm } from './ask-user-form'

/** The waiting `ask_user` call the form is drawn for. */
function call(): TranscriptToolCall {
  return {
    id: 'sevt_ask',
    name: 'ask_user',
    input: {},
    permission: 'ask',
    source: 'builtin',
    status: 'waiting',
    position: 2,
  }
}

const CHOICE: AskUserQuestion = {
  type: 'choice',
  question: 'Which environment should I deploy to?',
  header: 'Environment',
  options: [{ label: 'staging' }, { label: 'production', description: 'the live one' }],
}

const CHECKS: AskUserQuestion = {
  type: 'choice',
  question: 'Which checks should I run?',
  header: 'Checks',
  options: [{ label: 'tests' }, { label: 'lint' }],
  multi_select: true,
}

const NOTES: AskUserQuestion = {
  type: 'text',
  question: 'Anything else I should know?',
  header: 'Notes',
  placeholder: 'optional',
}

const CHANGELOG: AskUserQuestion = {
  type: 'confirm',
  question: 'Update the changelog?',
  header: 'Log',
}

/**
 * The `ask_user` form (epic #303, X6; #310).
 *
 * What this file holds is the web's half: the controls each question type gets, the write-in,
 * the problems that hold Submit, and the two events — every answer, or a decline.
 */
describe('AskUserForm (#310)', () => {
  it('draws each question with its header and the control its type takes', () => {
    render(
      <AskUserForm
        call={call()}
        questions={[CHOICE, NOTES, CHANGELOG]}
        busy={false}
        onRespond={() => {}}
      />,
    )

    expect(screen.getByText('Environment')).toBeInTheDocument()
    expect(screen.getByText('Which environment should I deploy to?')).toBeInTheDocument()
    // A single-select question is radios, an option's description rides beside its label.
    expect(screen.getByRole('radio', { name: /staging/ })).toBeInTheDocument()
    expect(screen.getByText('the live one')).toBeInTheDocument()
    // A text question is an input, a confirm one is a yes/no pair.
    expect(
      screen.getByRole('textbox', { name: 'Anything else I should know?' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'No' })).toBeInTheDocument()
    // Every question always offers its own answer — the type allows it, not the call.
    expect(screen.getByRole('radio', { name: /Other/ })).toBeInTheDocument()
  })

  it('is checkboxes when the call asks for several', () => {
    render(<AskUserForm call={call()} questions={[CHECKS]} busy={false} onRespond={() => {}} />)

    expect(screen.getByRole('checkbox', { name: /tests/ })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /lint/ })).toBeInTheDocument()
  })

  it('holds Submit until every question is answered, naming what is missing', async () => {
    const onRespond = vi.fn()
    render(
      <AskUserForm
        call={call()}
        questions={[CHOICE, CHANGELOG]}
        busy={false}
        onRespond={onRespond}
      />,
    )

    const submit = screen.getByRole('button', { name: 'Submit' })
    expect(submit).toBeDisabled()
    expect(
      screen.getByText('Environment: choose an option, or write an answer of your own'),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('radio', { name: /staging/ }))
    expect(submit).toBeDisabled()

    await userEvent.click(screen.getByRole('radio', { name: 'Yes' }))
    expect(submit).toBeEnabled()
  })

  it('sends every answer at once, in the order the model asked', async () => {
    const onRespond = vi.fn()
    render(
      <AskUserForm
        call={call()}
        questions={[CHOICE, NOTES, CHANGELOG]}
        busy={false}
        onRespond={onRespond}
      />,
    )

    await userEvent.click(screen.getByRole('radio', { name: /production/ }))
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Anything else I should know?' }),
      'the release is on Thursday',
    )
    await userEvent.click(screen.getByRole('radio', { name: 'No' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onRespond).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_ask',
      result: 'allow',
      answers: [
        { question: CHOICE.question, labels: ['production'] },
        { question: NOTES.question, text: 'the release is on Thursday' },
        { question: CHANGELOG.question, confirmed: false },
      ],
    })
  })

  it('takes more than one option where the question allows it', async () => {
    const onRespond = vi.fn()
    render(<AskUserForm call={call()} questions={[CHECKS]} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /tests/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: [{ question: CHECKS.question, labels: ['tests', 'lint'] }],
      }),
    )
  })

  it('writes in the reader’s own answer beside the options', async () => {
    const onRespond = vi.fn()
    render(<AskUserForm call={call()} questions={[CHOICE]} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('radio', { name: /Other/ }))
    await userEvent.type(
      screen.getByRole('textbox', {
        name: 'Your own answer for “Which environment should I deploy to?”',
      }),
      'eu-west-1',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: [{ question: CHOICE.question, text: 'eu-west-1' }],
      }),
    )
  })

  it('declines with a denial, which is the one event that says "not answered"', async () => {
    const onRespond = vi.fn()
    render(<AskUserForm call={call()} questions={[CHOICE]} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))

    expect(onRespond).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_ask',
      result: 'deny',
    })
  })

  it('turns the controls off while a confirmation is in flight', () => {
    render(<AskUserForm call={call()} questions={[CHOICE]} busy onRespond={() => {}} />)

    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /staging/ })).toBeDisabled()
  })
})
