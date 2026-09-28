import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { App } from './App'
import {
  agentText,
  isStreaming,
  makeFake,
  messageElement,
  renderApp,
  visibleText,
} from './test-support/render-app'

/**
 * The chat, end to end, against `createFakeClient()`.
 *
 * Nothing here reaches into the app: the tests type, click and read the screen the way a user
 * would, and check the fake server's log for the events the UI should have sent. The delays
 * are what make streaming observable — with the fake's default pace a reply can be finished
 * before the first assertion runs.
 */

const REPLY = 'Hello there, friend!'

describe('App', () => {
  it('opens the seeded session and lists it in the sidebar', async () => {
    const fake = makeFake()
    renderApp(fake)

    expect(await screen.findByRole('heading', { name: 'Summarizer' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Summarizer/ })).toHaveAttribute(
      'href',
      `#/s/${fake.session.id}`,
    )
    expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
  })

  it('sends a message and renders the reply as it streams in', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ delayMs: 200 })
    fake.respondWith(REPLY, { chunks: 4 })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'Hi there')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('Hi there')).toBeInTheDocument()
    expect(await screen.findByLabelText('Status: Running')).toBeInTheDocument()

    // Deltas: the reply is on screen while it is still a strict prefix of the whole thing,
    // which is what "streamed" means here — not a finished message appearing at once.
    await waitFor(() => {
      expect(isStreaming()).toBe(true)
      const partial = agentText()
      expect(partial.length).toBeGreaterThan(0)
      expect(REPLY).toContain(partial)
      expect(partial).not.toBe(REPLY)
    })

    expect(await screen.findByText(REPLY, {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
    })
  })

  it('stops a running reply with user.interrupt and keeps what was written', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ delayMs: 200 })
    const long = 'One two three four five six seven eight nine ten'
    fake.respondWith(long, { chunks: 8 })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'go')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const stop = await screen.findByRole('button', { name: 'Stop' })
    await waitFor(() => {
      expect(agentText().length).toBeGreaterThan(0)
    })
    await user.click(stop)

    await fake.waitForIdle()
    await waitFor(() => {
      expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
    })

    expect(fake.history().some((event) => event.type === 'user.interrupt')).toBe(true)
    const partial = agentText()
    expect(partial.length).toBeGreaterThan(0)
    expect(long).toContain(partial)
    expect(partial).not.toBe(long)
  })

  it('restores the full history after a reload and resumes the stream', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.respondWith('Remembered reply.')

    const first = renderApp(fake)
    await user.type(await screen.findByLabelText('Message'), 'remember this')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText('Remembered reply.')).toBeInTheDocument()

    // A reload: the app unmounts, the fake server keeps the log.
    first.unmount()
    fake.respondWith('Second reply.')
    renderApp(fake)

    expect(await screen.findByText('remember this')).toBeInTheDocument()
    expect(await screen.findByText('Remembered reply.')).toBeInTheDocument()

    // …and the live stream is back: the next turn arrives without a reload.
    await user.type(screen.getByLabelText('Message'), 'and again')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText('Second reply.')).toBeInTheDocument()
  })

  it('keeps the input enabled while running, queues a steering message, and answers it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ delayMs: 200 })
    fake.respondWith('Answer one.', { chunks: 6 })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'first')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('button', { name: 'Stop' })

    // Steering: the box stays usable while the agent is working.
    const input = screen.getByLabelText('Message')
    expect(input).toBeEnabled()
    await user.type(input, 'also this')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // It shows as queued — the brain has not reached it yet…
    await waitFor(() => {
      const queued = document.querySelector('[data-role="user"][data-pending="true"]')
      expect(visibleText(queued)).toContain('also this')
    })

    // …then the reply lands, the queued message follows it, and the next turn answers it.
    // Both waits cover a slow reply, not just a slow query: the fake is still streaming.
    expect(await screen.findByText('Answer one.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(
      await screen.findByText('Fake reply: also this', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(messageElement('user')).not.toBeNull()
    expect(fake.history().filter((event) => event.type === 'user.message')).toHaveLength(2)
  })

  it('shows a retrying error, then clears it when the retry succeeds', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ delayMs: 200 })
    fake.failWith({ retryStatus: 'retrying' })
    fake.respondWith('Second time lucky.')
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('model_overloaded_error')
    expect(alert).toHaveTextContent('retrying')

    expect(await screen.findByText('Second time lucky.', {}, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('keeps a terminal error on screen until something replaces it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ delayMs: 150 })
    fake.failWith({
      type: 'model_request_failed_error',
      message: 'The model request failed.',
      retryStatus: 'terminal',
    })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('model_request_failed_error')
    expect(alert).toHaveTextContent('The model request failed.')
    await waitFor(() => {
      expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
    })

    // The turn is over; the error stays, and the box is live again — the next turn clears it.
    fake.respondWith('Trying again.')
    await user.type(screen.getByLabelText('Message'), 'again')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText('Trying again.')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('creates a chat from the new-chat screen and focuses the composer', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/new' })

    const agentPicker = await screen.findByLabelText('Agent')
    expect(agentPicker).toHaveValue(fake.agent.id)

    await user.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    expect(await screen.findByLabelText('Message')).toHaveFocus()

    const listed = await fake.sessions.list()
    expect(listed.data).toHaveLength(2)
  })

  it('shows a request error inline when the session does not exist', async () => {
    const fake = makeFake()
    window.location.hash = '#/s/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ'

    render(<App client={fake} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('No session')
  })
})
