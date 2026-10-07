import type { TranscriptMessage } from '@openharness/client'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { MessageItem } from './message-item'

/**
 * One message, and the foot under it (issue #212).
 *
 * The rules here are the ones that are about a *message* rather than about the transcript:
 * what the action row copies, which message gets Edit and resend, that a reply being written
 * but not yet arrived draws nothing at all, and that the metadata line is drawn where the
 * message is. The wiring to the rest of the app — the composer the edit lands in, the model
 * the row compares against — is `App.test.tsx`'s and `message-list`'s.
 */

/** Install a clipboard the test can read. jsdom has no `navigator.clipboard` of its own. */
function stubClipboard(): Mock<(text: string) => Promise<void>> {
  const writeText = vi.fn<(text: string) => Promise<void>>()
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/** A message, with whatever the case is about overridden. */
function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: 'sevt_message',
    role: 'agent',
    text: 'Hello.',
    parts: [{ type: 'text', text: 'Hello.' }],
    pending: false,
    streaming: false,
    position: 1,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MessageItem', () => {
  it('copies the message’s source, and says so', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    render(<MessageItem message={message({ text: 'The markdown **source**' })} />)

    await user.click(screen.getByRole('button', { name: 'Copy message' }))
    // The source, not the rendered text: what the reader gets back is what was written.
    expect(writeText).toHaveBeenCalledWith('The markdown **source**')
    // The name follows the icon, so the confirmation is not something only the picture says.
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('claims nothing when the clipboard refuses', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    writeText.mockRejectedValue(new Error('NotAllowedError'))
    render(<MessageItem message={message()} />)

    await user.click(screen.getByRole('button', { name: 'Copy message' }))
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
  })

  it('offers Edit and resend only when the caller says this message is the one', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const { unmount } = render(
      <MessageItem message={message({ role: 'user', text: 'say again' })} />,
    )
    expect(screen.queryByRole('button', { name: 'Edit and resend' })).toBeNull()
    unmount()

    render(<MessageItem message={message({ role: 'user', text: 'say again' })} onEdit={onEdit} />)
    await user.click(screen.getByRole('button', { name: 'Edit and resend' }))
    // The button hands the edit over; putting the text in the box is the screen's business.
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('draws a reply that is streaming but has not arrived yet as nothing at all', () => {
    // The empty preview the working row at the foot of the transcript already speaks for: a
    // caret in an empty bubble is the same fact twice, once of them a grey block (#212).
    render(<MessageItem message={message({ streaming: true, text: '', parts: [] })} />)
    expect(document.querySelector('[data-role="agent"]')).toBeNull()
    expect(screen.queryByText('The assistant is replying…')).toBeNull()
  })

  it('keeps the caret once the reply has a word in it', () => {
    render(<MessageItem message={message({ streaming: true, text: 'Hel' })} />)
    const agent = document.querySelector('[data-role="agent"]')
    expect(agent).not.toBeNull()
    expect(agent).toHaveAttribute('data-streaming', 'true')
    expect(within(agent as HTMLElement).getByText('The assistant is replying…')).toBeInTheDocument()
  })

  it('carries the metadata line, and the model only when it changed', () => {
    const meta = { model: 'anthropic/claude-sonnet-5', durationMs: 4200 }
    // No catalog is passed here, so the id is what the line names — `message-meta.test.tsx`
    // is where the display name and the rest of the line are the subject.
    const { unmount } = render(<MessageItem message={message({ meta })} />)
    expect(screen.getByText('anthropic/claude-sonnet-5')).toBeInTheDocument()
    unmount()

    render(<MessageItem message={message({ meta })} previousModel="anthropic/claude-sonnet-5" />)
    expect(screen.queryByText('anthropic/claude-sonnet-5')).toBeNull()
    expect(screen.getByText('4.2s')).toBeInTheDocument()
  })

  it('has no metadata line under the reader’s own message', () => {
    render(<MessageItem message={message({ role: 'user' })} />)
    expect(document.querySelector('[data-slot="message-meta"]')).toBeNull()
  })

  it('keeps a message’s bubbles able to shrink, so a wide block scrolls inside it', () => {
    // The narrow-screen bug (#212): at ~400px a code block or a table has to fit the message
    // column with its own scrollbar, not overflow the transcript. jsdom has no layout, so this
    // asserts the classes that make it possible — `min-w-0` on the bubble, so it may be
    // narrower than what is inside it, and `min-w-0`/`max-w-full` on the foot, so neither it
    // nor the bubble next to it can push the transcript wide. What it *looks* like is a
    // browser question; that nothing here is allowed to grow is not.
    render(<MessageItem message={message()} />)
    const bubble = document.querySelector('[data-role="agent"] > div')
    expect(bubble?.className).toContain('min-w-0')
    expect(bubble?.className).toContain('max-w-[85%]')
    const foot = document.querySelector('[data-slot="message-foot"]')
    expect(foot?.className).toContain('min-w-0')
    expect(foot?.className).toContain('max-w-full')
  })
})
