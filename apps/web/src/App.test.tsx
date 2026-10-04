import { AuthenticationError } from '@openharness/client'
import type { ModelEntry } from '@openharness/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { saveSettings } from './lib/settings'
import {
  agentText,
  isStreaming,
  makeFake,
  messageElement,
  recordListRequests,
  renderApp,
  sessionRows,
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
    const fake = makeFake({ delayMs: 200 })
    fake.respondWith(REPLY, { chunks: 4 })
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'Hi there')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The message is on screen — and, being the session's first, it also named the session,
    // so the header shows the same words: assert on the transcript, not just anywhere.
    await waitFor(() => {
      expect(visibleText(messageElement('user'))).toContain('Hi there')
    })
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

    await waitFor(() => {
      expect(visibleText(messageElement('user'))).toContain('remember this')
    })
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

  it('creates a model-first chat from the new-chat screen and focuses the composer', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/new' })

    // The picker's default is the catalog's first entry — the fake's one model — and no
    // agent is involved anywhere on the screen.
    const modelPicker = await screen.findByRole('button', { name: /Model/ })
    expect(modelPicker).toHaveTextContent('Claude Sonnet 5')
    // The old "create an agent first" onboarding is gone with the agents screen.
    expect(screen.queryByText(/create one on the/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    expect(await screen.findByLabelText('Message')).toHaveFocus()

    const listed = await fake.sessions.list()
    expect(listed.data).toHaveLength(2)
    const created = listed.data.find((session) => session.id !== fake.session.id)
    expect(created?.model.id).toBe('anthropic/claude-sonnet-5')
    expect(created?.agent).toBeNull()
  })

  it('shows the new title in the sidebar and the header without a reload', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    const lists = recordListRequests(fake)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: 'Create chat' }))
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    const sessionId = window.location.hash.replace('#/s/', '')
    // The bug of #35: a new chat is listed and headed by a fallback name, because nothing has
    // named the session yet — since #91, the model's display name.
    expect(screen.getByRole('heading', { name: 'Claude Sonnet 5' })).toBeInTheDocument()

    await user.type(await screen.findByLabelText('Message'), 'a chat about the release checklist')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

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
