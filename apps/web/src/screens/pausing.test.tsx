import type { AskUserQuestion } from '@openharness/protocol'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../test-support/render-app'

/**
 * The pause, end to end in the browser (epic #303, X6; #310).
 *
 * The fake's brain asks through `askWith` (tested in `@openharness/client`), so this is the
 * whole round trip the app drives: the turn ends waiting, the form is drawn from the log, the
 * answers go up as one `user.tool_confirmation`, and the call stops waiting — the same path a
 * reload takes, because the log is where the question lives.
 */

const QUESTIONS: AskUserQuestion[] = [
  {
    type: 'choice',
    question: 'Which environment should I deploy to?',
    header: 'Env',
    options: [{ label: 'staging' }, { label: 'production', description: 'the live one' }],
  },
  { type: 'confirm', question: 'Go ahead?', header: 'Go' },
]

/** A fake paused on `ask_user`, with the message that asked it already in the log. */
async function paused() {
  const fake = makeFake()
  fake.askWith({ questions: QUESTIONS })
  await fake.sendMessage(fake.session.id, 'deploy it')
  await fake.waitForIdle()
  return fake
}

describe('a paused chat (#303, #310)', () => {
  it('draws the question a reloaded session is waiting on', async () => {
    const fake = await paused()
    renderApp(fake)

    const form = within(await screen.findByRole('form', { name: 'Questions from ask_user' }))
    expect(form.getByText('Which environment should I deploy to?')).toBeInTheDocument()
    expect(form.getByText('the live one')).toBeInTheDocument()
    expect(form.getByRole('radio', { name: 'Yes' })).toBeInTheDocument()
  })

  it('sends every answer as one confirmation and stops waiting', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = await paused()
    renderApp(fake)

    const form = within(await screen.findByRole('form', { name: 'Questions from ask_user' }))
    await user.click(form.getByRole('radio', { name: /staging/ }))
    await user.click(form.getByRole('radio', { name: 'Yes' }))
    await user.click(form.getByRole('button', { name: 'Submit' }))

    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Questions from ask_user' })).toBeNull()
    })
    // The log is the record: the confirmation, and the result the answers became.
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user.tool_confirmation',
          result: 'allow',
          answers: [
            { question: QUESTIONS[0]?.question, labels: ['staging'] },
            { question: QUESTIONS[1]?.question, confirmed: true },
          ],
        }),
      ]),
    )
    // The answers **are** the call's result — the tool never runs — so the log holds them in
    // the wording the model reads, and the row no longer says it is waiting.
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.tool_result',
          is_error: false,
          content: [{ type: 'text', text: 'Which environment should I deploy to?: staging\nGo ahead?: Yes' }],
        }),
      ]),
    )
    expect(screen.queryByText('waiting for you')).toBeNull()
  })

  it('declines the call when the reader will not answer', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = await paused()
    renderApp(fake)

    await user.click(
      within(await screen.findByRole('form', { name: 'Questions from ask_user' })).getByRole(
        'button',
        { name: 'Decline' },
      ),
    )

    await waitFor(() => {
      expect(screen.queryByRole('form', { name: 'Questions from ask_user' })).toBeNull()
    })
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'user.tool_confirmation', result: 'deny' }),
      ]),
    )
  })

  it('says a message would decline what is waiting, and sending one does', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = await paused()
    fake.respondWith('ok then')
    renderApp(fake)

    expect(
      await screen.findByText('Sending a message will decline the item waiting on you.'),
    ).toBeInTheDocument()

    await user.type(screen.getByLabelText('Message'), 'never mind{Enter}')

    // The brain resolves the waiting call with its own sentence, and the row says so rather
    // than reading as a failure.
    expect(await screen.findByText('dismissed')).toBeInTheDocument()
    expect(fake.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.tool_result',
          is_error: true,
          content: [{ type: 'text', text: 'The user sent a message instead.' }],
        }),
      ]),
    )
  })
})
