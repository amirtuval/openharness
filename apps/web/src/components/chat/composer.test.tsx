import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ANTHROPIC, OPENAI, providerStatus } from '../../test-support/catalog'
import { ModelPicker } from '../models/model-picker'
import { Composer } from './composer'

/**
 * The composer's keyboard path (issue #105, P1): Enter sends, Shift+Enter starts a new line,
 * an empty or whitespace-only body sends nothing, and Send is disabled while there is nothing
 * to send. These are the rules the whole chat rests on, and none of them had a test — every
 * chat test clicked the Send button.
 *
 * Written against the composer as it is now, model selector included (epic #116): the
 * selector is part of the input area, so it is part of what the keyboard tests render.
 */
function setup(onSend: (text: string) => boolean | void | Promise<boolean | void> = () => true) {
  const user = userEvent.setup({ delay: null })
  const send = vi.fn(onSend)
  render(
    <Composer
      running={false}
      onSend={send}
      onStop={vi.fn()}
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

  it('shows the model selector in the input area', async () => {
    const { user } = setup()

    const selector = screen.getByRole('button', { name: /Model: Claude Sonnet 5/ })
    // The app's own listbox, not a native select (#87).
    expect(selector).toHaveAttribute('aria-haspopup', 'listbox')

    await user.click(selector)
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument()
  })
})
