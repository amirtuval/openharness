import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Composer } from './composer'

/**
 * The composer's keyboard contract.
 *
 * The chat's main input path — everything in `App.test.tsx` clicks the Send button — and the
 * one its own comment describes: Enter sends, Shift+Enter starts a new line, a blank body
 * sends nothing, and the button says when there is nothing to send.
 */

/** The composer with send/stop recorded. */
function renderComposer(options: { running?: boolean } = {}) {
  const onSend = vi.fn()
  const onStop = vi.fn()
  render(<Composer running={options.running ?? false} onSend={onSend} onStop={onStop} />)
  return { onSend, onStop, input: screen.getByLabelText('Message') }
}

describe('the composer', () => {
  it('sends the trimmed message on Enter, and clears the box', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSend, input } = renderComposer()

    await user.type(input, '  hello there  ')
    await user.keyboard('{Enter}')

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith('hello there')
    expect(input).toHaveValue('')
  })

  it('starts a new line on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSend, input } = renderComposer()

    await user.type(input, 'first')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(input, 'second')

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('first\nsecond')
  })

  it('sends nothing for a blank body, and disables the button until there is one', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSend, input } = renderComposer()
    const send = screen.getByRole('button', { name: 'Send message' })

    expect(send).toBeDisabled()
    await user.type(input, '   ')
    expect(send).toBeDisabled()

    await user.keyboard('{Enter}')
    expect(onSend).not.toHaveBeenCalled()

    await user.type(input, 'now it has words')
    expect(send).toBeEnabled()

    await user.click(send)
    expect(onSend).toHaveBeenCalledWith('now it has words')
    expect(input).toHaveValue('')
  })

  it('offers Stop only while running, and Send always', async () => {
    const user = userEvent.setup({ delay: null })
    const onSend = vi.fn()
    const onStop = vi.fn()
    const { rerender } = render(<Composer running={false} onSend={onSend} onStop={onStop} />)

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()

    rerender(<Composer running onSend={onSend} onStop={onStop} />)
    await user.click(screen.getByRole('button', { name: 'Stop' }))

    expect(onStop).toHaveBeenCalledTimes(1)
    // Send does not disappear while the turn runs: a message sent now is a steering message.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument()
  })

  it('leaves Enter to the input method while a composition is in flight', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSend, input } = renderComposer()

    await user.type(input, 'にほんご')
    // What an IME-driven Enter looks like: `key: 'Enter'` with `isComposing` set, which the
    // composer must ignore so the candidate window's Enter does not submit the message.
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    )

    expect(onSend).not.toHaveBeenCalled()
  })
})
