import { ApiError, AuthenticationError } from '@openharness/client'
import { EVENT_TYPES } from '@openharness/protocol'
import type { ModelEntry } from '@openharness/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { App } from './App'
import { settingsHash } from './lib/router'
import { saveSettings } from './lib/settings'
import { NEW_CHAT_GREETING } from './screens/new-chat-screen'
import { authClientCalls } from './test-support/better-auth-client-mock'
import { TWO_PROVIDERS, WITH_DEFAULT, modelEntry } from './test-support/catalog'
import {
  agentText,
  deriveSessionTitles,
  isStreaming,
  makeFake,
  workingRow,
  messageElement,
  messageElements,
  openAccountMenu,
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

    // The reply's cost, and the session's, are computed from the catalog's rates and the
    // tokens the log reported (#247): the fake's default catalog prices the model, and the
    // header's total is the same money the reply's row shows.
    const cost = document.querySelector('[data-slot="message-cost"]')
    expect(cost?.textContent).toMatch(/^\$/)
    const total = document.querySelector('[data-slot="session-cost"]')
    expect(total?.textContent).toBe(cost?.textContent)
  })

  it('shows a dash for a session whose model nobody prices (#247)', async () => {
    const user = userEvent.setup({ delay: null })
    // A catalog with one model nobody prices, which is not the model the session runs: the
    // reply's own model has no published rate either way.
    const fake = makeFake({
      models: [modelEntry({ id: 'acme/mystery-1', provider: 'acme', name: 'Mystery' })],
    })
    fake.respondWith('Hello there.')
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'Hi there')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    // The reply's cost arrives with its span end, which follows the message itself.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="message-cost"]')).not.toBeNull()
    })

    // The tokens are real and the money is not known: "—", never `$0.00`.
    expect(document.querySelector('[data-slot="message-cost"]')?.textContent).toBe('—')
    expect(document.querySelector('[data-slot="session-cost"]')?.textContent).toBe('—')
  })

  it('sums the priced requests and names the unpriced ones in the session total (#247)', async () => {
    // A session that ran a priced model and then a model nobody prices: the money is what the
    // priced request came to, and the unpriced one is counted beside it (decided 2026-10-09) —
    // one request with no published price no longer turns the whole total into `—`.
    const fake = makeFake({
      models: [
        modelEntry({
          id: 'anthropic/claude-sonnet-5',
          provider: 'anthropic',
          name: 'Claude Sonnet 5',
          cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        }),
        modelEntry({ id: 'acme/mystery-1', provider: 'acme', name: 'Mystery' }),
      ],
    })
    fake.respondWith('Hello there.')
    await fake.sendMessage(fake.session.id, 'Hi there')
    await fake.waitForIdle(fake.session.id)
    fake.respondWith('On the other model.')
    await fake.sendMessage(fake.session.id, 'Again', { model: { id: 'acme/mystery-1' } })
    await fake.waitForIdle(fake.session.id)
    renderApp(fake)

    const total = await waitFor(() => {
      const element = document.querySelector('[data-slot="session-cost"]')
      expect(element?.textContent).toMatch(/unpriced/)
      return element as HTMLElement
    })
    // 512 in at $2/Mtok and 32 out at $10/Mtok, once — the priced part — plus the one request
    // on the unpriced model.
    expect(total.textContent).toBe('$0.0013 + 1 unpriced')
    // The count is explained, not just printed.
    expect(total.getAttribute('title')).toBe(
      '1 request had no published price and is not in the total.',
    )
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

    // And the foot of the transcript says what the reader did (U10). Nothing in the log
    // distinguishes "the reader stopped this" from "the turn ended", so this is the screen's
    // own memory of the one action that could only have come from here.
    expect(workingRow()).toHaveTextContent('Interrupted')

    // It belongs to the turn it stopped: the next message is a new one, and the row goes with
    // the old.
    await user.type(screen.getByLabelText('Message'), 'again')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(workingRow()).toBeNull()
  })

  it('says the turn is working, at the foot of the transcript, until text arrives', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    fake.respondWith('A reply that takes a moment to start.', { chunks: 8, delayMs: 20 })
    const stream = gateStream(fake)
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), 'go')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // Running, and not a word of the reply on screen yet: the row is the only thing that says
    // anything is happening, and it is where the reply is about to appear.
    await stream.until(() => workingRow() !== null, 'the working row')
    expect(workingRow()).toHaveTextContent('Working…')
    // A clock, not a spinner: the wait is the one thing the header indicator cannot say.
    expect(workingRow()?.textContent).toMatch(/\ds/)

    // The delta is the progress report from there on.
    await stream.until(() => agentText().length > 0, 'the first delta')
    expect(workingRow()).toBeNull()
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
    // about it, so the banner offers it (epic #65, A5).
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('missing_provider_credential')
    expect(alert).toHaveTextContent('No anthropic credential is saved for this account.')

    // Since #209 the fix happens **here**: the seeded session runs a model whose provider is
    // `anthropic`, so the Add-provider dialog opens on that provider's form rather than on a
    // link to another screen.
    await user.click(within(alert).getByRole('button', { name: 'Add a provider key' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Connect Anthropic')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('API key')).toBeInTheDocument()
    // Still on the chat underneath: this is a dialog, not a navigation.
    expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
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
    // A message switched the session before this client ever saw it, so the log already says
    // which model the session runs — the form a resumed chat reads.
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

  it('marks the first switch of a chat started from a model (#268)', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    fake.respondWith('ok')
    // The seeded session runs Claude Sonnet 5 and has said nothing yet. The transcript is
    // seeded with that model when the session is opened, so switching before the first message
    // is a change it can mark — the bug was that it had nothing to compare against, and drew
    // the first switch silently.
    renderApp(fake)

    const selector = await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' })
    await user.click(selector)
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))

    await user.type(screen.getByLabelText('Message'), 'switch please')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('Switched to GPT-4.1 mini')).toBeInTheDocument()
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

  it('builds the auth client against the configured server', () => {
    // Sign-in and the API have to be the same server (App.tsx): the API client is built from
    // the same `settings.serverUrl` the auth client is handed, and the module double records
    // what it was constructed with (#105, P2).
    saveSettings({ serverUrl: 'http://localhost:8787' })
    renderApp(makeFake(), { hash: '#/' })

    expect(authClientCalls.at(-1)?.baseURL).toBe('http://localhost:8787')
  })

  it('leaves the auth client on this origin when no server URL is set', () => {
    // Empty means the page's own origin — Better Auth's own `/api/auth` default — so no
    // `baseURL` is passed at all.
    saveSettings({ serverUrl: '' })
    renderApp(makeFake(), { hash: '#/' })

    const options = authClientCalls.at(-1)
    expect(options?.baseURL).toBeUndefined()
    expect(options?.plugins).toHaveLength(1)
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
      cost: null,
      source: 'provider',
    }
    // The seeded session runs anthropic/claude-sonnet-5; this catalog does not list it.
    const fake = makeFake({ models: [other] })
    renderApp(fake)

    expect(
      await screen.findByRole('heading', { name: 'anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument()
  })

  it('keeps the agents screen out of navigation, and its old route lands on the root', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    renderApp(fake, { hash: '#/' })

    const sidebar = await screen.findByRole('complementary', { name: 'Navigation' })
    expect(within(sidebar).queryByRole('link', { name: /Agents/ })).not.toBeInTheDocument()

    // Settings is in the sidebar still, one menu down (U10): the account menu at its foot.
    await openAccountMenu(user)
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      settingsHash(),
    )
    await user.keyboard('{Escape}')

    // An old bookmark to the screen: the route is gone, so it opens the root route — which is
    // New chat since #209 (the Home screen is gone), not a dead end.
    window.location.hash = '#/agents'
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: NEW_CHAT_GREETING })).toBeInTheDocument()
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
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
    // An account with a key, so `#/new` is New chat rather than the first-run flow (#209).
    const fake = makeFake(WITH_DEFAULT)
    renderApp(fake, { hash: '#/' })

    const screens: ReadonlyArray<readonly [hash: string, heading: string]> = [
      ['#/new', NEW_CHAT_GREETING],
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

  describe('the foot of a message, and the keyboard (#212)', () => {
    /** The first line to a reply that streams, so a test can stop it at a chosen moment. */
    const SLOW = 'One two three four five six seven eight nine ten eleven twelve'

    /** Install a clipboard the test can read. jsdom has no `navigator.clipboard` of its own. */
    function stubClipboard(): Mock<(text: string) => Promise<void>> {
      const writeText = vi.fn<(text: string) => Promise<void>>()
      writeText.mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      return writeText
    }

    /**
     * A window at least `md` wide, or not — jsdom has no `matchMedia` to ask.
     *
     * The sidebar shortcut moves the column on a wide window and the drawer on a narrow one
     * (#211), so which of them the test is about has to be said rather than measured.
     */
    function stubWindowWidth(wide: boolean): void {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: wide && query === '(min-width: 768px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }))
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /**
     * Send `text`, and wait until its reply has arrived and the turn is over.
     *
     * The wait is on the *reply*, not on the idle status: the screen is idle before the fake
     * has begun the turn, so a wait on idleness alone can be satisfied by the state it was
     * already in — and the next message would then be a steering message. One more reply,
     * stored (not streaming), on an idle session is the turn having happened.
     */
    async function send(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
      const replies = messageElements('agent').length + 1
      await user.type(await screen.findByLabelText('Message'), text)
      await user.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => {
        expect(messageElements('agent')).toHaveLength(replies)
        expect(isStreaming()).toBe(false)
        expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
      })
    }

    it('shows only the working row until the reply has a word in it', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith(SLOW, { chunks: 12, delayMs: 20 })
      const stream = gateStream(fake)
      renderApp(fake)

      await user.type(await screen.findByLabelText('Message'), 'go')
      await user.click(screen.getByRole('button', { name: 'Send message' }))

      // `event_start` is what opens the streaming preview, and it carries no text at all: the
      // transcript has a reply on it from here, and the screen must not draw one. It used to
      // draw an empty agent bubble with a caret in it, next to a row saying the same thing.
      await stream.until(
        () => stream.released.includes('event_start'),
        'the reply’s opening chunk event',
      )
      expect(document.querySelector('[data-role="agent"]')).toBeNull()
      expect(workingRow()).toHaveTextContent('Working…')

      // The first delta is the message: text, caret and all.
      await stream.until(() => agentText().length > 0, 'the first delta')
      expect(document.querySelector('[data-role="agent"]')).not.toBeNull()
      expect(isStreaming()).toBe(true)
    })

    it('reports what a reply cost, under it, once the log says', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('One.')
      renderApp(fake)

      await send(user, 'first')

      // The fake's span events are the server's: this model served it, and it reported 512
      // input and 32 output tokens (#201, U1) — 544, with the thousands separator a count
      // gets. The duration is the wait, which under the fake is a few milliseconds.
      const meta = document.querySelector('[data-slot="message-meta"]')
      // The cost rides at the end of the same line (#247), computed from the catalog's rates.
      expect(meta?.textContent).toMatch(/^Claude Sonnet 5 · \d+(\.\d+)?s · 544 tokens · \$0\.\d+$/)
      // And it is not part of the reply: the message is still what the model wrote.
      expect(agentText()).toBe('One.')

      // A second reply on the same model does not name it again: the model is news once.
      fake.respondWith('Two.')
      await send(user, 'second')
      const lines = [...document.querySelectorAll('[data-slot="message-meta"]')]
      expect(lines).toHaveLength(2)
      expect(lines[1]?.textContent).not.toContain('Claude Sonnet 5')
      expect(lines[1]?.textContent).toMatch(/tokens · \$\d/)
    })

    it('puts a message’s source on the clipboard from its action row', async () => {
      const user = userEvent.setup({ delay: null })
      const writeText = stubClipboard()
      const fake = makeFake()
      fake.respondWith('**bold** answer')
      renderApp(fake)

      await send(user, 'the question')
      const reply = messageElement('agent') as HTMLElement
      await user.hover(reply)
      await user.click(within(reply).getByRole('button', { name: 'Copy message' }))

      // The markdown source, not the rendered text: what the reader gets back is what was
      // written, which is the point of copying an agent message at all.
      expect(writeText).toHaveBeenCalledWith('**bold** answer')
      expect(await within(reply).findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    })

    it('offers Edit and resend on every message the reader wrote (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('One.')
      renderApp(fake)

      await send(user, 'the first thing')
      fake.respondWith('Two.')
      await send(user, 'the second thing')

      // One action per message the reader wrote, and none on the agent's replies: rewriting a
      // reply is not a thing, and rewriting *any* of their own is — sending it rewinds the
      // session to that message, so the branch behind it is what gets replaced.
      const users = messageElements('user')
      const edits = screen.getAllByRole('button', { name: 'Edit and resend' })
      expect(users).toHaveLength(2)
      expect(edits).toHaveLength(2)
      expect(
        within(messageElements('agent')[0] as HTMLElement).queryByRole('button', {
          name: 'Edit and resend',
        }),
      ).toBeNull()

      // The **first** one: its words go back in the box, with the cursor, and nothing else
      // happens — an edit that is never sent is not an edit.
      const box = screen.getByLabelText('Message')
      await user.hover(users[0] as HTMLElement)
      await user.click(
        within(users[0] as HTMLElement).getByRole('button', { name: 'Edit and resend' }),
      )

      expect(box).toHaveValue('the first thing')
      expect(box).toHaveFocus()
      expect(fake.history().filter((event) => event.type === EVENT_TYPES.userMessage)).toHaveLength(
        2,
      )
      expect(visibleText(messageElements('agent').at(-1) ?? null)).toBe('Two.')
    })

    it('sends an edit as a rewind, and the transcript drops what it replaced (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('Rain, on the window.')
      renderApp(fake)

      await send(user, 'write a haiku about rain')
      const users = messageElements('user')
      await user.hover(users[0] as HTMLElement)
      await user.click(
        within(users[0] as HTMLElement).getByRole('button', { name: 'Edit and resend' }),
      )

      // The reader edits the text and sends: the conversation restarts from the edit, so the
      // original message and its reply are gone from the transcript and the model never sees
      // them — which is the whole of "edit and resend" (#238).
      fake.respondWith('Snow, on the window.')
      const box = screen.getByLabelText('Message')
      await user.click(box)
      await user.keyboard('!')
      await user.click(screen.getByRole('button', { name: 'Send message' }))

      await waitFor(() => {
        expect(visibleText(messageElements('agent').at(-1) ?? null)).toBe('Snow, on the window.')
      })
      expect(messageElements('user')).toHaveLength(1)
      expect(visibleText(messageElements('user')[0] ?? null)).toBe('write a haiku about rain!')
      // The log holds the rewind the server wrote, covering everything before it, and the
      // transcript is the reply that followed the edit.
      const rewind = fake.history().find((event) => event.type === 'session.rewind')
      expect(rewind).toBeDefined()
      expect(rewind).toMatchObject({
        supersedes: { from_seq: 1, to_seq: (rewind?.seq ?? 0) - 1 },
      })
      expect(visibleText(messageElements('agent').at(-1) ?? null)).toBe('Snow, on the window.')
    })

    it('does not rewind when the edit is cancelled by clearing the box (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('Rain, on the window.')
      renderApp(fake)

      await send(user, 'write a haiku about rain')
      const users = messageElements('user')
      await user.hover(users[0] as HTMLElement)
      await user.click(
        within(users[0] as HTMLElement).getByRole('button', { name: 'Edit and resend' }),
      )

      // The reader takes the edit back — the box is empty — and writes something else. That is
      // a new message at the end of the conversation, not a rewind: the branch they almost took
      // back is theirs to keep.
      fake.respondWith('Another answer.')
      const box = screen.getByLabelText('Message')
      await user.clear(box)
      await user.type(box, 'something else entirely')
      await user.click(screen.getByRole('button', { name: 'Send message' }))

      await waitFor(() => {
        expect(visibleText(messageElements('agent').at(-1) ?? null)).toBe('Another answer.')
      })
      expect(fake.history().some((event) => event.type === EVENT_TYPES.sessionRewind)).toBe(false)
      expect(messageElements('user').map(visibleText)).toEqual([
        'write a haiku about rain',
        'something else entirely',
      ])
    })

    it('disables Edit and resend while the agent is working (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith(SLOW, { chunks: 8, delayMs: 20 })
      renderApp(fake)

      await user.type(await screen.findByLabelText('Message'), 'go')
      await user.click(screen.getByRole('button', { name: 'Send message' }))
      await waitFor(() => {
        expect(screen.getByLabelText('Status: Running')).toBeInTheDocument()
      })

      // The turn in flight owns the branch being taken back, and the server refuses the rewind
      // (409) while it runs — so the action is not offered until it is done.
      const users = messageElements('user')
      const edit = within(users[0] as HTMLElement).getByRole('button', { name: 'Edit and resend' })
      expect(edit).toBeDisabled()

      await waitFor(() => {
        expect(screen.getByLabelText('Status: Idle')).toBeInTheDocument()
      })
      expect(edit).toBeEnabled()
    })

    /** Open the edit on `index` of the reader's own messages, the way the transcript offers it. */
    async function startEditing(
      user: ReturnType<typeof userEvent.setup>,
      index: number,
    ): Promise<void> {
      const users = messageElements('user')
      await user.hover(users[index] as HTMLElement)
      await user.click(
        within(users[index] as HTMLElement).getByRole('button', { name: 'Edit and resend' }),
      )
    }

    it('shows what a send would replace while editing, and Cancel takes the edit back (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('One.')
      renderApp(fake)
      await send(user, 'the first thing')

      await startEditing(user, 0)

      // The mode is visible, not remembered silently: the composer says what a send would do.
      expect(
        screen.getByText('Editing message · sending replaces what follows it'),
      ).toBeInTheDocument()

      // Cancel takes the edit back — the draft goes with it, which is what clearing the box does,
      // and the action is gone.
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText(/Editing message/)).toBeNull()
      expect(screen.getByLabelText('Message')).toHaveValue('')

      // Nothing was rewound, and the conversation is exactly what it was.
      expect(messageElements('user').map(visibleText)).toEqual(['the first thing'])
      expect(visibleText(messageElements('agent')[0] ?? null)).toBe('One.')
      expect(fake.history().some((event) => event.type === EVENT_TYPES.sessionRewind)).toBe(false)
    })

    it('leaves edit mode on Escape (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('One.')
      renderApp(fake)
      await send(user, 'the first thing')

      await startEditing(user, 0)
      expect(screen.getByText(/Editing message/)).toBeInTheDocument()

      const box = screen.getByLabelText('Message')
      await user.click(box)
      await user.keyboard('{Escape}')

      expect(screen.queryByText(/Editing message/)).toBeNull()
      expect(box).toHaveValue('')
    })

    it('marks the messages an edit would replace (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('One.')
      renderApp(fake)
      await send(user, 'the first thing')
      fake.respondWith('Two.')
      await send(user, 'the second thing')

      // Editing the first message puts everything after it on its way out — the reader can see
      // what the send would take back, not only read it in the composer.
      await startEditing(user, 0)
      expect(messageElements('user')[0]).toHaveAttribute('data-replacing', 'false')
      expect(messageElements('agent')[0]).toHaveAttribute('data-replacing', 'true')
      expect(messageElements('user')[1]).toHaveAttribute('data-replacing', 'true')
      expect(messageElements('agent')[1]).toHaveAttribute('data-replacing', 'true')

      // And taking the edit back puts them back: nothing is dimmed until an edit is pending.
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(document.querySelectorAll('[data-replacing="true"]')).toHaveLength(0)
    })

    it('withholds an edit a running turn would refuse, and keeps the draft (#238)', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith('One.')
      renderApp(fake)
      await send(user, 'the first thing')

      await startEditing(user, 0)
      const box = screen.getByLabelText('Message')
      await user.click(box)
      await user.keyboard('!')

      // Another tab sends: the turn starts while the edit is still pending, and the server
      // would refuse the rewind now (409). Its own turn streams in like any other.
      fake.respondWith(SLOW, { chunks: 8, delayMs: 20 })
      await fake.sendMessage(fake.session.id, 'from another tab')
      await waitFor(() => {
        expect(screen.getByLabelText('Status: Running')).toBeInTheDocument()
      })

      // The box keeps the draft, says what to wait for, and nothing is posted — Enter included.
      expect(screen.getByText('Editing message · wait for the reply to finish')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
      await user.keyboard('{Enter}')
      expect(box).toHaveValue('the first thing!')
      expect(fake.history().some((event) => event.type === EVENT_TYPES.sessionRewind)).toBe(false)
    })

    it('is Ctrl/⌘+Shift+O for a new chat, from anywhere', async () => {
      const user = userEvent.setup({ delay: null })
      // An account with a key, so New chat is New chat rather than the first-run flow (#209).
      const fake = makeFake(WITH_DEFAULT)
      renderApp(fake)
      await screen.findByLabelText('Message')

      await user.keyboard('{Control>}{Shift>}o{/Shift}{/Control}')

      await waitFor(() => {
        expect(window.location.hash).toBe('#/new')
      })
      expect(await screen.findByRole('heading', { name: NEW_CHAT_GREETING })).toBeInTheDocument()
    })

    it('puts the cursor in the message box with `/`, but only outside a field', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      renderApp(fake)

      const box = await screen.findByLabelText('Message')
      box.blur()
      expect(box).not.toHaveFocus()

      await user.keyboard('/')
      expect(box).toHaveFocus()
      // A shortcut, not a character: nothing was typed into the box.
      expect(box).toHaveValue('')

      // And the other half of the rule — inside the box a bare key is a key. `?` opens the
      // sheet from anywhere on the page, and from the box it is a question mark.
      await user.keyboard('?')
      expect(box).toHaveValue('?')
      expect(screen.queryByText('Keyboard shortcuts')).toBeNull()
    })

    it('is `?` for the shortcut list, and Ctrl/⌘+/ for the same list', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      renderApp(fake)

      // A chat opens with the cursor in the box, and a shortcut that fired from there would
      // be a shortcut fired by someone typing: the reader clicks off it first.
      const box = await screen.findByLabelText('Message')
      box.blur()

      await user.keyboard('?')
      expect(await screen.findByText('Keyboard shortcuts')).toBeInTheDocument()
      await user.keyboard('{Escape}')
      await waitFor(() => {
        expect(screen.queryByText('Keyboard shortcuts')).toBeNull()
      })

      // The second door, for hands that are already on a modifier.
      await user.keyboard('{Control>}/{/Control}')
      expect(await screen.findByText('Keyboard shortcuts')).toBeInTheDocument()
    })

    it('is Ctrl/⌘+B for the sidebar — the column on a wide window, the drawer on a phone', async () => {
      const user = userEvent.setup({ delay: null })

      stubWindowWidth(true)
      const wide = makeFake()
      const { unmount } = renderApp(wide)
      const column = await screen.findByRole('complementary', { name: 'Navigation' })
      expect(column).not.toHaveClass('md:hidden')

      await user.keyboard('{Control>}b{/Control}')
      expect(column).toHaveClass('md:hidden')
      // The same key brings it back, and the shell's own bar is what says so.
      await user.keyboard('{Control>}b{/Control}')
      expect(column).not.toHaveClass('md:hidden')
      unmount()

      // Below `md` the column is not the layout — the panel is the drawer, opened from the
      // top bar's button, which is state the shortcut moves too.
      stubWindowWidth(false)
      const narrow = makeFake()
      renderApp(narrow)
      const menu = await screen.findByRole('button', { name: 'Navigation' })
      expect(menu).toHaveAttribute('aria-expanded', 'false')
      await user.keyboard('{Control>}b{/Control}')
      expect(menu).toHaveAttribute('aria-expanded', 'true')
    })

    it('is Escape to stop a running turn, from the box, and nothing when nothing is running', async () => {
      const user = userEvent.setup({ delay: null })
      const fake = makeFake()
      fake.respondWith(SLOW, { chunks: 12, delayMs: 100 })
      const stream = gateStream(fake)
      renderApp(fake)

      const box = await screen.findByLabelText('Message')
      await user.type(box, 'go')
      await user.click(screen.getByRole('button', { name: 'Send message' }))
      await stream.until(() => agentText().length > 0, 'the first delta')

      // Stop is the box's key, and the click on Send left the focus on Send: the reader is
      // back in the box, which is half of the rule.
      await user.click(box)
      expect(box).toHaveFocus()
      await user.keyboard('{Escape}')

      await fake.waitForIdle()
      await stream.until(() => screen.queryByLabelText('Status: Idle') !== null, 'idle')
      expect(fake.history().filter((event) => event.type === 'user.interrupt')).toHaveLength(1)

      // Idle, the same key does nothing — Escape is the overlays' again.
      await user.keyboard('{Escape}')
      expect(fake.history().filter((event) => event.type === 'user.interrupt')).toHaveLength(1)
    })
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

describe('the /compact command (#283)', () => {
  it('asks for a manual compaction with the reader’s instructions instead of sending a message', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake)

    const input = await screen.findByLabelText('Message')
    await user.type(input, '/compact keep the API decisions')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The request is stored, with the guidance, and the box is cleared.
    await waitFor(() => {
      const request = fake.history().find((event) => event.type === EVENT_TYPES.sessionCompact)
      expect(request).toMatchObject({ instructions: 'keep the API decisions' })
    })
    expect(input).toHaveValue('')

    // Nothing was sent as words: the line is a command, not a message.
    expect(
      fake
        .history()
        .some(
          (event) =>
            event.type === EVENT_TYPES.userMessage &&
            event.content.some((block) => block.text.includes('/compact')),
        ),
    ).toBe(false)
  })

  it('runs a bare /compact with no instructions', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake)

    await user.type(await screen.findByLabelText('Message'), '/compact')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(fake.history().some((event) => event.type === EVENT_TYPES.sessionCompact)).toBe(true)
    })
    const request = fake.history().find((event) => event.type === EVENT_TYPES.sessionCompact)
    expect(request).not.toHaveProperty('instructions')
  })
})
