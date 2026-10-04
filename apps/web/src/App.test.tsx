import { ApiError, AuthenticationError } from '@openharness/client'
import type { ModelEntry } from '@openharness/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { saveSettings } from './lib/settings'
import { TWO_PROVIDERS, WITH_DEFAULT } from './test-support/catalog'
import {
  agentText,
  deriveSessionTitles,
  isStreaming,
  makeFake,
  messageElement,
  recordListRequests,
  renderApp,
  sessionRows,
  visibleText,
} from './test-support/render-app'
import { gateStream } from './test-support/stream'

/**
 * The chat, end to end, against `createFakeClient()`.
 *
 * Nothing here reaches into the app: the tests type, click and read the screen the way a user
 * would, and check the fake server's log for the events the UI should have sent.
 *
 * The streaming tests drive the fake's stream **event by event** (`gateStream`), rather than
 * racing a wall-clock `delayMs` (#105, P2): the fake still produces the whole turn, but the
 * app only sees the events the test releases, so "the reply is on screen as a prefix" is an
 * assertion about state, not about being fast enough.
 */

const REPLY = 'Hello there, friend!'

describe('App', () => {
  it('opens the seeded session and lists it in the sidebar', async () => {
    const fake = makeFake()
    renderApp(fake)

    // The seeded session has no title, so it is labelled by its model's display name from
    // the catalog (the fake's default entry) — never by the agent it was created from (#91).
    expect(await screen.findByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Claude Sonnet 5/ })).toHaveAttribute(
      'href',
      `#/s/${fake.session.id}`,
    )
    expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
  })

  it('sends a message and renders the reply as it streams in', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.respondWith(REPLY, { chunks: ['Hello ', 'there, ', 'friend!'] })
    const stream = gateStream(fake)
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'Hi there')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The message shows before any streamed event is released: the POST's own copy is folded
    // in, so the reader never waits on the stream to echo their own message. It is also the
    // session's first, so the fake — like the server — names the session after it and the
    // header reads the same words: assert on the transcript, not just anywhere on screen.
    await waitFor(() => {
      expect(visibleText(messageElement('user'))).toContain('Hi there')
    })
    // The stream follows the history with deltas on (#91's rule, pinned here).
    expect(stream.calls).toHaveLength(1)
    expect(stream.calls[0]?.deltas).toBe(true)

    await stream.until(
      () => screen.queryByLabelText('Status: Running') !== null,
      'the running status',
    )

    // Deltas: the reply is on screen while it is still a strict prefix of the whole thing,
    // which is what "streamed" means here — not a finished message appearing at once. The
    // gate released exactly the events up to the first delta; nothing can arrive behind it.
    await stream.until(() => agentText().length > 0, 'the first delta')
    expect(isStreaming()).toBe(true)
    const partial = agentText()
    expect(partial.length).toBeGreaterThan(0)
    expect(REPLY).toContain(partial)
    expect(partial).not.toBe(REPLY)

    await stream.until(() => agentText() === REPLY, 'the complete reply')
    await stream.until(() => screen.queryByLabelText('Status: Idle') !== null, 'idle')
    expect(isStreaming()).toBe(false)
  })

  it('stops a running reply with user.interrupt and keeps what was written', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    const long =
      'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen ' +
      'sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four'
    // A deliberately slow fake reply — 40 fragments at 100ms, four seconds in all — so the
    // Stop lands while the turn is genuinely running. The test does not wait those four
    // seconds: the interrupt cuts the reply within one fragment, and the gate releases what
    // the turn wrote before it stopped.
    fake.respondWith(long, { chunks: 40, delayMs: 100 })
    const stream = gateStream(fake)
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'go')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await stream.until(() => agentText().length > 0, 'the first delta')

    const stop = await screen.findByRole('button', { name: 'Stop' })
    await user.click(stop)

    await fake.waitForIdle()
    await stream.until(() => screen.queryByLabelText('Status: Idle') !== null, 'idle')

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
    const fake = makeFake()
    fake.respondWith('Answer one.', { chunks: ['Answer ', 'one.'] })
    const stream = gateStream(fake)
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'first')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    // Release the first turn up to the reply, deliberately leaving its end events unsent: the
    // app is mid-request — that is the moment a steering message happens in.
    await stream.until(() => agentText() === 'Answer one.', 'the first reply')
    await stream.until(
      () => document.querySelector('[data-role="user"][data-pending="true"]') === null,
      'the first message to be picked up',
    )

    // Steering: the box stays usable while the agent is working.
    const input = screen.getByLabelText('Message')
    expect(input).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    await user.type(input, 'also this')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // It shows as queued — the model request is still open, so nothing has reached it.
    const queued = document.querySelector('[data-role="user"][data-pending="true"]')
    expect(visibleText(queued)).toContain('also this')

    // …then the queued message's turn is answered, right behind the first reply.
    await stream.until(
      () => screen.queryByText('Fake reply: also this') !== null,
      'the answer to the steering message',
    )
    expect(messageElement('user')).not.toBeNull()
    expect(fake.history().filter((event) => event.type === 'user.message')).toHaveLength(2)
  })

  it('shows a retrying error, then clears it when the retry succeeds', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.failWith({ retryStatus: 'retrying' })
    fake.respondWith('Second time lucky.')
    const stream = gateStream(fake)
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await stream.until(() => screen.queryByRole('alert') !== null, 'the retry error')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('model_overloaded_error')
    expect(alert).toHaveTextContent('retrying')

    await stream.until(
      () => screen.queryByText('Second time lucky.') !== null,
      'the successful retry',
    )
    // The reply that superseded the error took the banner with it (the stored `agent.message`
    // is what clears it, not the preview's last delta).
    await stream.until(() => screen.queryByRole('alert') === null, 'the error to clear')
  })

  it('turns a missing provider credential into a way to fix it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.failWith({
      type: 'missing_provider_credential',
      message: 'No anthropic credential is saved for this account.',
      retryStatus: 'exhausted',
    })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The error is the agent's, not the request's — and there is exactly one thing to do
    // about it, so the banner says where (epic #65, A5).
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('missing_provider_credential')
    expect(alert).toHaveTextContent('No anthropic credential is saved for this account.')
    expect(
      within(alert).getByRole('link', { name: 'Add a key in Settings → Model providers' }),
    ).toHaveAttribute('href', '#/settings')
  })

  it('keeps a terminal error on screen until something replaces it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.failWith({
      type: 'model_request_failed_error',
      message: 'The model request failed.',
      retryStatus: 'terminal',
    })
    const stream = gateStream(fake)
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await stream.until(() => screen.queryByRole('alert') !== null, 'the terminal error')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('model_request_failed_error')
    expect(alert).toHaveTextContent('The model request failed.')
    await stream.until(() => screen.queryByLabelText('Status: Idle') !== null, 'idle')

    // The turn is over; the error stays, and the box is live again — the next turn clears it.
    fake.respondWith('Trying again.')
    await user.type(screen.getByLabelText('Message'), 'again')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await stream.until(() => screen.queryByText('Trying again.') !== null, 'the next reply')
    await stream.until(() => screen.queryByRole('alert') === null, 'the error to clear')
  })

  it('switches the model from the composer, sends it with the next message, and marks it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    fake.respondWith('ok')
    // The log already says which model the session runs: the first model a message carries
    // merely sets it (U3, silently), so a *change* needs one in effect first.
    await fake.sendMessage(fake.session.id, 'hi', { model: { id: 'anthropic/claude-sonnet-5' } })
    await fake.waitForIdle()
    renderApp(fake)

    const selector = await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' })
    await user.click(selector)
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Message'), 'switch please')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The switch rode the message — `user.message.model` — and the transcript marks where the
    // conversation changed engines, with the catalog's display name.
    expect(await screen.findByText('Switched to GPT-4.1 mini')).toBeInTheDocument()
    const messages = fake.history().filter((event) => event.type === 'user.message')
    const last = messages.at(-1)
    expect(last?.type === 'user.message' ? last.model?.id : null).toBe('openai/gpt-4.1-mini')

    // The selector now shows the session's model — the log's, not a leftover pick.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Model:/ })).toHaveTextContent('GPT-4.1 mini')
    })
  })

  it('shows the new title in the sidebar and the header without a reload', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    // The fake does not name sessions the way the server does; this is that half.
    deriveSessionTitles(fake)
    const lists = recordListRequests(fake)
    renderApp(fake, { hash: '#/new' })

    // New chat is immediate (U2): the chat is created by the first message, in place.
    await user.type(await screen.findByLabelText('Message'), 'a chat about the release checklist')
    // Send is disabled until the text is in the box, and a click on a disabled button
    // dispatches nothing — the send would never run and the hash would never move (#123).
    // Wait for the control to be actionable the way a reader would.
    const send = screen.getByRole('button', { name: 'Send message' })
    await waitFor(() => {
      expect(send).toBeEnabled()
    })
    await user.click(send)

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    const sessionId = window.location.hash.replace('#/s/', '')

    // The server named the session inside the request that stored the message; both surfaces
    // pick the title up from the one re-read, with no reload and no second walk of the list.
    expect(
      await screen.findByRole('heading', { name: 'a chat about the release checklist' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /a chat about the release checklist/ }),
    ).toHaveAttribute('href', `#/s/${sessionId}`)
    expect(lists.sessions).toHaveLength(1)
  })

  it('names a chat by a first message it did not send', async () => {
    const fake = makeFake()
    deriveSessionTitles(fake)
    renderApp(fake)
    expect(await screen.findByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()

    // Another writer — the CLI, a second tab — says the first thing in the open session: the
    // stream delivers the message, and the title it produced has to reach this tab too.
    await fake.sendMessage(fake.session.id, 'what can you do?')

    expect(await screen.findByRole('heading', { name: 'what can you do?' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /what can you do\?/ })).toBeInTheDocument()
    expect(sessionRows()).toHaveLength(1)
  })

  it('shows a request error inline when the session does not exist', async () => {
    const fake = makeFake()
    window.location.hash = '#/s/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ'

    render(<App client={fake} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('No session')
  })

  it('names the server the app could not reach, instead of the browser’s "Failed to fetch"', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    // What `fetch` throws when nothing is listening: the browser's TypeError, which the
    // client passes through rather than wrapping.
    fake.sendMessage = () => Promise.reject(new TypeError('Failed to fetch'))
    saveSettings({ serverUrl: 'http://localhost:3000' })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'anyone there?')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      "Can't reach the openharness server at http://localhost:3000. Check that it's running, or change the server URL in Settings.",
    )
    expect(alert).not.toHaveTextContent('Failed to fetch')
  })

  it('sends the reader to sign in when a normal call answers 401', async () => {
    const fake = makeFake()
    // The session ends behind the app's back. The sidebar's list is the first to find out.
    fake.sessions.list = () => Promise.reject(new AuthenticationError('Not signed in.'))
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ providers: [], dev_login: false }), { status: 200 }),
        ),
      ),
    )
    try {
      renderApp(fake, { hash: '#/' })

      // Not an inline banner: there is no session to retry it with.
      expect(
        await screen.findByRole('heading', { name: 'Sign in to openharness' }),
      ).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * #91: a session is labelled by its title, else its model — never its agent — and the
 * agents screen is gone from the UI (the API keeps it).
 */
describe('model-first labels, hidden agents', () => {
  it('shows the title, else the model display name, in the sidebar and the header', async () => {
    const fake = makeFake()
    renderApp(fake)

    // The seeded session has no title: its label is the catalog's name for its model, and the
    // header shows the model's id under it. The agent it was created from is not named.
    expect(await screen.findByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('banner')).getByText('anthropic/claude-sonnet-5'),
    ).toBeInTheDocument()
    const row = sessionRows()[0] as HTMLElement
    expect(row).toHaveTextContent('Claude Sonnet 5')
    expect(row).toHaveTextContent('anthropic/claude-sonnet-5')
    expect(screen.queryByText('Summarizer')).not.toBeInTheDocument()
  })

  it('falls back to the model id when the catalog does not know the model', async () => {
    const other: ModelEntry = {
      id: 'openai/gpt-4.1-mini',
      provider: 'openai',
      name: 'GPT-4.1 mini',
      context_window: 128_000,
      max_output_tokens: null,
      source: 'provider',
    }
    // The seeded session runs anthropic/claude-sonnet-5; this catalog does not list it.
    const fake = makeFake({ models: [other] })
    renderApp(fake)

    expect(
      await screen.findByRole('heading', { name: 'anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument()
  })

  it('keeps the agents screen out of navigation, and its old route lands home', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/' })

    const sidebar = await screen.findByRole('complementary', { name: 'Navigation' })
    expect(within(sidebar).queryByRole('link', { name: /Agents/ })).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: /Settings/ })).toBeInTheDocument()

    // An old bookmark to the screen: the route is gone, so it opens the home screen.
    window.location.hash = '#/agents'
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'openharness' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('heading', { name: 'Agents' })).not.toBeInTheDocument()
  })
})

/**
 * Epic #116, U5: deleting a chat — from its sidebar row or the chat header, with an in-page
 * confirmation — and the stream event that tells an open chat it was deleted somewhere else.
 */
describe('deleting chats', () => {
  /** The sidebar row whose link points at `sessionId`. */
  function rowFor(sessionId: string): HTMLElement {
    const row = sessionRows().find(
      (element) => element.querySelector('a')?.getAttribute('href') === `#/s/${sessionId}`,
    )
    if (row === undefined) {
      throw new Error(`no sidebar row for ${sessionId}`)
    }
    return row
  }

  it('deletes the open chat from the header, after confirming in the page', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    renderApp(fake)
    expect(await screen.findByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete chat' }))
    // In the page, not a `window.confirm`: the question is an element, and so are the answers.
    expect(screen.getByText('Delete this chat and all its messages?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Delete this chat and all its messages?')).not.toBeInTheDocument()
    expect((await fake.sessions.list()).data).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Delete chat' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    // After deleting the open chat: New chat (U5) — and the session is gone from the fake.
    await waitFor(() => {
      expect(window.location.hash).toBe('#/new')
    })
    expect((await fake.sessions.list()).data).toEqual([])
    expect(sessionRows()).toHaveLength(0)
    // New chat is immediate: the composer, on the default, not a picker screen.
    expect(
      await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' }),
    ).toBeInTheDocument()
  })

  it('deletes chats from their sidebar rows, leaving the open one when it is not the target', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const other = await fake.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
    renderApp(fake)
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(2)
    })

    // A row carries a kebab menu with the delete action (U5).
    const otherRow = rowFor(other.id)
    await user.click(within(otherRow).getByRole('button', { name: 'Chat actions' }))
    await user.click(within(otherRow).getByRole('menuitem', { name: 'Delete chat' }))
    expect(within(otherRow).getByText('Delete this chat?')).toBeInTheDocument()
    await user.click(within(otherRow).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1)
    })
    expect((await fake.sessions.list()).data.map((session) => session.id)).toEqual([
      fake.session.id,
    ])
    // Deleting a chat that was not open leaves the reader where they were.
    expect(window.location.hash).toBe(`#/s/${fake.session.id}`)

    // And the same action on the *open* chat leaves it for New chat.
    const openRow = rowFor(fake.session.id)
    await user.click(within(openRow).getByRole('button', { name: 'Chat actions' }))
    await user.click(within(openRow).getByRole('menuitem', { name: 'Delete chat' }))
    await user.click(within(openRow).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(window.location.hash).toBe('#/new')
    })
    expect((await fake.sessions.list()).data).toEqual([])
  })

  it('keeps the chat and says why when a delete fails', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.sessions.delete = () => Promise.reject(new ApiError(500, 'Delete is unavailable.'))
    renderApp(fake)
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(1)
    })

    const row = rowFor(fake.session.id)
    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    await user.click(within(row).getByRole('menuitem', { name: 'Delete chat' }))
    await user.click(within(row).getByRole('button', { name: 'Delete' }))

    const alert = await within(row).findByRole('alert')
    expect(alert).toHaveTextContent('Delete is unavailable.')
    // Nothing was deleted: the row, the chat and the open screen are all still there.
    expect(sessionRows()).toHaveLength(1)
    expect((await fake.sessions.list()).data).toHaveLength(1)
    expect(window.location.hash).toBe(`#/s/${fake.session.id}`)
  })

  it('leaves the chat with a notice when it is deleted somewhere else', async () => {
    const fake = makeFake(WITH_DEFAULT)
    const stream = gateStream(fake)
    renderApp(fake)
    expect(await screen.findByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()

    // Another writer — `oh`, a second tab — deletes it. The stream's last event is
    // `session.deleted`, which is all this tab gets; it has to act on exactly that.
    await fake.sessions.delete(fake.session.id)
    await stream.until(() => window.location.hash === '#/new', 'the app to leave the chat')

    // A notice, on the screen the reader lands on, and no stale row for a chat that is gone.
    expect(screen.getByText('This chat was deleted.')).toBeInTheDocument()
    expect(sessionRows()).toHaveLength(0)
  })
})

/** The backdrop that covers the screen while the drawer is open. */
function backdrop(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="sidebar-backdrop"]')
  if (element === null) {
    throw new Error('the sidebar backdrop is not rendered')
  }
  return element
}

/**
 * The sidebar below `md`.
 *
 * jsdom has no layout and applies no stylesheet, so these assert the switch and the behaviour
 * around it: the `max-md:` classes that decide whether the panel is in the layout or over it,
 * the button that flips them, the three ways the drawer closes, and the focus that follows.
 * What 390px actually looks like is a browser question — see the viewport check in the issue.
 */
describe('the sidebar below md', () => {
  it('is a closed drawer with the right ARIA until the menu button opens it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake)

    const sidebar = await screen.findByRole('complementary', { name: 'Navigation' })
    const menu = screen.getByRole('button', { name: 'Navigation' })

    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(menu).toHaveAttribute('aria-controls', sidebar.id)
    expect(sidebar).toHaveClass('max-md:hidden')
    expect(document.querySelector('[data-slot="sidebar-backdrop"]')).toBeNull()

    await user.click(menu)

    expect(menu).toHaveAttribute('aria-expanded', 'true')
    expect(sidebar).not.toHaveClass('max-md:hidden')
    expect(backdrop()).toBeInTheDocument()
    // Focus follows the drawer in, so a keyboard user lands in the list that just opened.
    expect(sidebar).toHaveFocus()

    await user.click(menu)

    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(sidebar).toHaveClass('max-md:hidden')
    expect(document.querySelector('[data-slot="sidebar-backdrop"]')).toBeNull()
  })

  it('closes when a chat is picked from it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    // Start on the home screen: the seeded chat is not the one already open.
    renderApp(fake, { hash: '#/' })

    const sidebar = await screen.findByRole('complementary', { name: 'Navigation' })
    await user.click(screen.getByRole('button', { name: 'Navigation' }))
    await user.click(within(sidebar).getByRole('link', { name: /Claude Sonnet 5/ }))

    expect(sidebar).toHaveClass('max-md:hidden')
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/s/${fake.session.id}`)
    })
  })

  it('closes on Escape and on a backdrop click, and gives the focus back to the button', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake)

    const sidebar = await screen.findByRole('complementary', { name: 'Navigation' })
    const menu = screen.getByRole('button', { name: 'Navigation' })

    await user.click(menu)
    await user.keyboard('{Escape}')
    expect(sidebar).toHaveClass('max-md:hidden')
    expect(document.querySelector('[data-slot="sidebar-backdrop"]')).toBeNull()
    expect(menu).toHaveFocus()

    await user.click(menu)
    await user.click(backdrop())
    expect(sidebar).toHaveClass('max-md:hidden')
    expect(menu).toHaveFocus()
  })

  it('puts the menu button on every screen', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/' })

    const screens: ReadonlyArray<readonly [hash: string, heading: string]> = [
      ['#/new', 'New chat'],
      ['#/settings', 'Settings'],
    ]

    expect(await screen.findByRole('button', { name: 'Navigation' })).toBeInTheDocument()

    for (const [hash, heading] of screens) {
      window.location.hash = hash
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: 'Navigation' })).toBeInTheDocument()
    }
  })

  it('leaves the desktop column as it was', async () => {
    const fake = makeFake()
    renderApp(fake)

    const sidebar = await screen.findByRole('complementary', { name: 'Navigation' })

    // The 256px column is still the layout from `md` up, and nothing hides it outside a
    // breakpoint: every drawer rule is `max-md:`-scoped, so above the breakpoint the panel is
    // the same static column it has always been.
    expect(sidebar).toHaveClass('w-64', 'shrink-0')
    expect(sidebar).not.toHaveClass('hidden')
    expect([...sidebar.classList].filter((name) => name.startsWith('max-md:'))).not.toHaveLength(0)
  })
})
