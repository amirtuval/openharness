import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Typing in the composer must not re-render the conversation (#314, item 1).
 *
 * The draft lives in `ChatView` — it has to, because Edit and resend puts the reader's own
 * words back in the box — so every keystroke re-renders the screen. What must not happen is
 * that the re-render reaches the transcript: an open chat is the most expensive subtree on the
 * page, and re-rendering every message per character is the flicker the maintainer reported
 * (measured on a built server at ~23 ms of scripting per keystroke on a 27-message chat before
 * `MessageList` was memoized, ~5 ms after, and flat with the transcript's length).
 *
 * Counting renders of a real component is the only honest version of this assertion — a
 * re-render that produces identical DOM leaves no other trace — so `MessageItem` is replaced
 * by a stub that counts. It is the component the transcript is made of: if it does not
 * re-render, nothing under it does either.
 */
const counters = vi.hoisted(() => ({ messageItems: 0 }))

vi.mock('./message-item', () => ({
  MessageItem: (props: { readonly message: { readonly text: string } }) => {
    counters.messageItems += 1
    return <div data-testid="message-item">{props.message.text}</div>
  },
}))

describe('typing in the composer', () => {
  it('does not re-render the messages', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.respondWith('The reply.')
    await fake.sendMessage(fake.session.id, 'A message the reader sent.')
    await fake.waitForIdle()

    renderApp(fake)
    // Both sides of the conversation are on screen before anything is typed. The transcript is
    // read through the stubbed items: the session's own name and the sidebar row carry the same
    // words as the message does.
    const transcript = (): string[] =>
      screen.getAllByTestId('message-item').map((item) => item.textContent ?? '')
    await waitFor(() => {
      expect(transcript()).toEqual(['A message the reader sent.', 'The reply.'])
    })

    const box = screen.getByLabelText('Message')
    await user.click(box)
    const before = counters.messageItems

    await user.type(box, 'now I am typing')

    // The keystrokes happened — the draft is the box's value — and the conversation was not
    // touched by them.
    expect(box).toHaveValue('now I am typing')
    expect(counters.messageItems).toBe(before)

    // The other half of the same rule: the transcript *is* re-rendered when the transcript
    // changes, so the memo has not simply frozen the conversation.
    fake.respondWith('A second reply.')
    await user.type(box, '{Enter}')
    await waitFor(() => {
      expect(counters.messageItems).toBeGreaterThan(before)
    })
  })
})
