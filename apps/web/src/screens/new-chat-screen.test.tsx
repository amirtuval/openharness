import { ApiError } from '@openharness/client'
import type { FakeClient } from '@openharness/client/testing'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { OPENAI, TWO_PROVIDERS, WITH_DEFAULT, credential } from '../test-support/catalog'
import { makeFake, renderApp } from '../test-support/render-app'

/**
 * New chat is a chat, immediately (epic #116, U2): an empty composer on the account's default
 * model, the session created on the first send — no picker screen in the way. Driven against
 * `createFakeClient()`, so the session the app creates is asserted on the fake's own record
 * of the request, and the no-default and failure states are states a test renders.
 *
 * With no default the catalog decides what the screen is (#146): models mean a composer
 * waiting for a pick, no providers and no models mean "add a provider key", and a catalog
 * that is loading or failed is neither of those claims.
 */

/** The `create` bodies the app sent, in order. */
function recordCreates(fake: FakeClient): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = []
  const create = fake.sessions.create.bind(fake.sessions)
  fake.sessions.create = (body, options) => {
    calls.push(body)
    return create(body, options)
  }
  return calls
}

describe('New chat', () => {
  it('opens on the default model and creates the session with the first message', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    // The default from the server, in the composer's selector, before anything is sent.
    expect(
      await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' }),
    ).toBeInTheDocument()
    // Nothing exists until the reader says something.
    expect((await fake.sessions.list()).data).toHaveLength(1)

    const input = await screen.findByLabelText('Message')
    expect(input).toHaveFocus()
    await user.type(input, 'hello there')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    // Created for the send, with the default model, and the message is in the new chat's log.
    expect(creates).toEqual([{ model: { id: 'anthropic/claude-sonnet-5' } }])
    const sessionId = window.location.hash.replace('#/s/', '')
    expect(fake.history(sessionId).filter((event) => event.type === 'user.message')).toHaveLength(1)
    // The chat opens on it: a model-first chat, named by its first message — the fake derives
    // titles the way the server does (#35) — with the cursor in the box.
    expect(await screen.findByRole('heading', { name: 'hello there' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Message')).toHaveFocus()
  })

  it('creates the session with a model picked in the composer, not the default', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: 'Model: Claude Sonnet 5' }))
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(creates).toEqual([{ model: { id: OPENAI.id } }])
    })
  })

  it('says to add a provider key when there is no default, and links to Settings', async () => {
    // The one account where that claim is true (#146): no providers and no models either.
    const fake = makeFake({ models: [], providers: [], credentials: [credential('anthropic')] })
    renderApp(fake, { hash: '#/new' })

    expect(await screen.findByText('Add a provider key to start')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings → Providers' })).toHaveAttribute(
      'href',
      '#/settings',
    )
    // Nothing to type into: there is no model a message could run on.
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('offers the catalog and creates the session with the picked model when there is a key but no default (#146)', async () => {
    const user = userEvent.setup({ delay: null })
    // A key saved before automatic picking existed, or one whose pick failed at save time:
    // the catalog has models, the preferences have no default.
    const fake = makeFake({ ...TWO_PROVIDERS, preferences: { default_model: null } })
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    // Not the "add a provider key" state: the composer is here, with nothing selected.
    const trigger = await screen.findByRole('button', { name: 'Model: Choose a model' })
    expect(screen.queryByText('Add a provider key to start')).not.toBeInTheDocument()

    // Send is refused until a model is picked: no session is created and the text stays in
    // the box, with the hint saying what is missing.
    const input = screen.getByLabelText('Message')
    await user.type(input, 'hello?')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(creates).toEqual([])
    expect(window.location.hash).toBe('#/new')
    expect(input).toHaveValue('hello?')
    expect(screen.getByText(/Pick a model to start/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'set a default in Settings' })).toHaveAttribute(
      'href',
      '#/settings',
    )

    // A pick is all that was missing: the send then works exactly as with a default, and the
    // session is created with the picked model.
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(creates).toEqual([{ model: { id: OPENAI.id } }])
    })
    const sessionId = window.location.hash.replace('#/s/', '')
    expect((await fake.sessions.get(sessionId)).model.id).toBe(OPENAI.id)
  })

  it('preselects the only catalog model when there is no default (#146)', async () => {
    const user = userEvent.setup({ delay: null })
    // One model is no choice at all, so it stands in the way a default would.
    const fake = makeFake({ models: [OPENAI], credentials: TWO_PROVIDERS.credentials })
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    expect(await screen.findByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => {
      expect(creates).toEqual([{ model: { id: OPENAI.id } }])
    })
  })

  it('waits for the catalog instead of saying there are no keys (#146)', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    // Hold the catalog request open until the test releases it, the way the sidebar test
    // holds its later pages: "loading, not empty" is only observable while it is late.
    let releaseCatalog: (() => void) | undefined
    const list = fake.models.list.bind(fake.models)
    fake.models.list = async () => {
      await new Promise<void>((resolve) => {
        releaseCatalog = resolve
      })
      return list()
    }
    renderApp(fake, { hash: '#/new' })

    // The preferences answered (no default) while the catalog is still in flight: that is a
    // loading state — an account with models must never be told to add a key.
    expect(await screen.findByText('Loading your models…')).toBeInTheDocument()
    expect(screen.queryByText('Add a provider key to start')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(releaseCatalog).toBeDefined()
    })
    releaseCatalog?.()
    expect(await screen.findByRole('button', { name: 'Model: Choose a model' })).toBeInTheDocument()
  })

  it('shows a failed catalog load rather than claiming there are no keys (#146)', async () => {
    const fake = makeFake({ credentials: TWO_PROVIDERS.credentials })
    fake.models.list = () => Promise.reject(new ApiError(500, 'The catalog is unavailable.'))
    renderApp(fake, { hash: '#/new' })

    const banner = await screen.findByText('Could not load models')
    expect(banner.closest('[role="alert"]')).toHaveTextContent('The catalog is unavailable.')
    // The error, not the no-keys claim: the models are unknown, not absent.
    expect(screen.queryByText('Add a provider key to start')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Model: Choose a model' })).toBeInTheDocument()
    expect(screen.getByText(/Pick a model to start/)).toBeInTheDocument()
  })

  it('keeps the message and shows why when the session could not be created', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    fake.sessions.create = () => Promise.reject(new ApiError(400, 'The model id is not valid.'))
    renderApp(fake, { hash: '#/new' })

    await user.type(await screen.findByLabelText('Message'), 'hello?')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // Two things went wrong at once — the create failed, and the sidebar's list error shows
    // it too — so this asserts the composer's own banner, by its words.
    const banner = await screen.findByText('The chat could not be created.')
    expect(banner.closest('[role="alert"]')).toBeInTheDocument()
    // Still on New chat, with the text: the retry is one more click.
    expect(window.location.hash).toBe('#/new')
    expect(screen.getByLabelText('Message')).toHaveValue('hello?')
  })

  it('reuses the session it already created when only the message failed', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(WITH_DEFAULT)
    const creates = recordCreates(fake)
    const send = fake.sendMessage.bind(fake)
    let failNext = true
    fake.sendMessage = (sessionId, text, options) => {
      if (!failNext) {
        return send(sessionId, text, options)
      }
      failNext = false
      return Promise.reject(new ApiError(500, 'The message store is down.'))
    }
    renderApp(fake, { hash: '#/new' })

    await user.type(await screen.findByLabelText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The message store is down.')

    // The retry goes to the chat that exists — not a second create, not a second empty chat.
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    expect(creates).toHaveLength(1)
    expect((await fake.sessions.list()).data).toHaveLength(2)
  })

  it('shows a failed catalog load without blocking the composer', async () => {
    const fake = makeFake(WITH_DEFAULT)
    fake.models.list = () => Promise.reject(new ApiError(500, 'The catalog is unavailable.'))
    renderApp(fake, { hash: '#/new' })

    const banner = await screen.findByText('Could not load models')
    expect(banner.closest('[role="alert"]')).toHaveTextContent('The catalog is unavailable.')
    // The default is still known and the chat can still start; the catalog is a convenience,
    // and without it the selector falls back to the id it was handed.
    expect(
      screen.getByRole('button', { name: 'Model: anthropic/claude-sonnet-5' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
  })

  it('shows a failed preferences load, and still lets a model be picked by hand', async () => {
    const fake = makeFake(WITH_DEFAULT)
    fake.preferences.get = () => Promise.reject(new ApiError(500, 'The preferences store is down.'))
    renderApp(fake, { hash: '#/new' })

    const banner = await screen.findByText('Could not load your default model')
    expect(banner.closest('[role="alert"]')).toHaveTextContent('The preferences store is down.')
    // No default is known, so the selector starts on nothing — but the catalog is there, and
    // a pick is enough to start a chat.
    const trigger = screen.getByRole('button', { name: 'Model: Choose a model' })
    expect(trigger).toBeInTheDocument()

    const user = userEvent.setup({ delay: null })
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(screen.getByRole('button', { name: 'Model: GPT-4.1 mini' })).toBeInTheDocument()
  })
})
