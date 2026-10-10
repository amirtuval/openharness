import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ANTHROPIC, OPENAI, providerStatus } from '../../test-support/catalog'
import { ModelPicker } from '../models/model-picker'
import { Composer, type ComposerEdit } from './composer'

/**
 * The composer's keyboard path (issue #105, P1): Enter sends, Shift+Enter starts a new line,
 * an empty or whitespace-only body sends nothing, and Send is disabled while there is nothing
 * to send. These are the rules the whole chat rests on, and none of them had a test — every
 * chat test clicked the Send button.
 *
 * Written against the composer as it is now, model selector included (epic #116): the
 * selector is part of the input area, so it is part of what the keyboard tests render.
 *
 * Edit mode (#238) is the second thing the box owns: the indicator above it, Escape and
 * Cancel, and a send withheld while the screen says the rewind would be refused.
 */
function setup(
  onSend: (text: string) => boolean | void | Promise<boolean | void> = () => true,
  edit?: ComposerEdit,
) {
  const user = userEvent.setup({ delay: null })
  const send = vi.fn(onSend)
  render(
    <Composer
      running={false}
      onSend={send}
      onStop={vi.fn()}
      edit={edit}
      modelSelector={
        <ModelPicker
          variant="compact"
          models={[ANTHROPIC, OPENAI]}
          providers={[providerStatus('anthropic'), providerStatus('openai')]}
          value={ANTHROPIC.id}
          onChange={() => undefined}
        />
      }
    />,
  )
  return {
    user,
    send,
    input: screen.getByLabelText('Message'),
    sendButton: screen.getByRole('button', { name: 'Send message' }),
  }
}

describe('Composer', () => {
  it('sends on Enter and clears the box', async () => {
    const { user, send, input } = setup()

    await user.type(input, 'hello there')
    await user.keyboard('{Enter}')

    expect(send).toHaveBeenCalledWith('hello there')
    expect(input).toHaveValue('')
  })

  it('starts a new line on Shift+Enter instead of sending', async () => {
    const { user, send, input } = setup()

    await user.type(input, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(input, 'line two')

    expect(send).not.toHaveBeenCalled()
    expect(input).toHaveValue('line one\nline two')
  })

  it('sends nothing for an empty or whitespace-only body', async () => {
    const { user, send, sendButton, input } = setup()

    // Empty: Enter and the disabled button both do nothing.
    await user.keyboard('{Enter}')
    await user.click(sendButton)
    expect(send).not.toHaveBeenCalled()

    // Whitespace is empty once it is trimmed, and the button says so.
    await user.type(input, '   ')
    expect(sendButton).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(send).not.toHaveBeenCalled()
  })

  it('disables Send while there is nothing to send, and enables it with text', async () => {
    const { user, sendButton, input } = setup()

    expect(sendButton).toBeDisabled()

    await user.type(input, 'hi')
    expect(sendButton).toBeEnabled()

    await user.clear(input)
    expect(sendButton).toBeDisabled()
  })

  it('keeps the text when the send was not stored', async () => {
    const { user, send, input, sendButton } = setup(() => false)

    await user.type(input, 'keep me')
    await user.click(sendButton)

    expect(send).toHaveBeenCalledWith('keep me')
    // The one moment losing what you wrote hurts most is the one where it did not go.
    expect(input).toHaveValue('keep me')
  })

  it('says what a send would do while editing, and leaves on Cancel (#238)', async () => {
    const onCancel = vi.fn()
    const { user } = setup(() => true, { blocked: false, onCancel })

    // The reader is told what pressing Send does before they press it: the messages after the
    // one being rewritten are about to be replaced.
    expect(
      screen.getByText('Editing message · sending replaces what follows it'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('leaves edit mode on Escape (#238)', async () => {
    const onCancel = vi.fn()
    const { user, input } = setup(() => true, { blocked: false, onCancel })

    await user.click(input)
    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('withholds a send the screen says would be refused, and says why (#238)', async () => {
    const { user, send, input, sendButton } = setup(() => true, {
      blocked: true,
      onCancel: vi.fn(),
    })

    await user.type(input, 'the rewrite')
    // The turn in flight owns the branch the rewind would replace, so the server would refuse
    // it (409): the box says what to wait for and offers no send — the button or Enter.
    expect(screen.getByText('Editing message · wait for the reply to finish')).toBeInTheDocument()
    expect(sendButton).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(send).not.toHaveBeenCalled()
    // And nothing was lost: the edit is still in the box, waiting for the turn to end.
    expect(input).toHaveValue('the rewrite')
  })

  it('hints at the /compact command while it is being typed (#283)', async () => {
    const { user, input } = setup()

    // Nothing is offered for an ordinary message, and a bare slash is one keystroke from one.
    expect(screen.queryByText('/compact [instructions]')).not.toBeInTheDocument()
    await user.type(input, '/')
    expect(screen.queryByText('/compact [instructions]')).not.toBeInTheDocument()

    // A prefix of the command names it, and the description says what running it does.
    await user.type(input, 'comp')
    expect(screen.getByText('/compact [instructions]')).toBeInTheDocument()
    expect(screen.getByText('Summarize the older history now')).toBeInTheDocument()

    // It is still just a line until it is sent — clearing the box clears the hint.
    await user.clear(input)
    expect(screen.queryByText('/compact [instructions]')).not.toBeInTheDocument()
  })

  it('offers no hint for a line that names no command (#283)', async () => {
    const { user, input } = setup()

    await user.type(input, '/composing a thought')
    expect(screen.queryByText('/compact [instructions]')).not.toBeInTheDocument()
  })

  it('shows the model selector in the input area', async () => {
    const { user } = setup()

    const selector = screen.getByRole('button', { name: /Model: Claude Sonnet 5/ })
    // The app's own listbox, not a native select (#87).
    expect(selector).toHaveAttribute('aria-haspopup', 'listbox')

    await user.click(selector)
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument()
  })
})
