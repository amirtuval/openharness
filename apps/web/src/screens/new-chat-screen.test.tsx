import { ApiError } from '@openharness/client'
import type { ModelEntry, ProviderCatalogStatus } from '@openharness/protocol'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp, sessionRows } from '../test-support/render-app'

/**
 * New chat: pick a model (#91, epic #92).
 *
 * The screen is driven against `createFakeClient()` with a configured catalog, so the tests
 * click and type the way a reader does: open the picker, search, pick, create. The session
 * the app creates is asserted on the fake's own record of the request.
 */

/** A catalog entry with the fields a test does not care about filled in. */
function entry(
  overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'provider' | 'name'>,
): ModelEntry {
  return {
    context_window: null,
    max_output_tokens: null,
    source: 'provider',
    ...overrides,
  }
}

const ANTHROPIC: ModelEntry = entry({
  id: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  name: 'Claude Sonnet 5',
  context_window: 200_000,
})
const OPENAI: ModelEntry = entry({
  id: 'openai/gpt-4.1-mini',
  provider: 'openai',
  name: 'GPT-4.1 mini',
  context_window: 128_000,
})

function status(
  provider: string,
  overrides: Partial<ProviderCatalogStatus> = {},
): ProviderCatalogStatus {
  return {
    provider,
    status: 'ok',
    fetched_at: '2026-10-04T10:00:00.000Z',
    message: null,
    ...overrides,
  }
}

const TWO_PROVIDERS = {
  models: [ANTHROPIC, OPENAI],
  providers: [status('anthropic'), status('openai')],
}

/** The `create` bodies the app sent, in order. */
function recordCreates(fake: ReturnType<typeof makeFake>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = []
  const create = fake.sessions.create.bind(fake.sessions)
  fake.sessions.create = (body, options) => {
    calls.push(body)
    return create(body, options)
  }
  return calls
}

/** The group inside the open listbox for one provider. */
function group(provider: string): HTMLElement {
  return within(screen.getByRole('listbox', { name: 'Models' })).getByRole('group', {
    name: provider,
  })
}

/** The picker's trigger button. */
function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /Model/ })
}

describe('New chat: pick a model', () => {
  it('groups the catalog by provider, with display names, ids and context windows', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/new' })

    // Before anything is chosen, the first catalog entry stands in — no empty picker.
    const button = await screen.findByRole('button', { name: /Model/ })
    expect(button).toHaveTextContent('Claude Sonnet 5')

    await user.click(button)

    const anthropic = group('anthropic')
    expect(within(anthropic).getByText('Claude Sonnet 5')).toBeInTheDocument()
    expect(within(anthropic).getByText(/anthropic\/claude-sonnet-5/)).toBeInTheDocument()
    expect(within(anthropic).getByText(/200K context/)).toBeInTheDocument()

    const openai = group('openai')
    expect(within(openai).getByText('GPT-4.1 mini')).toBeInTheDocument()
    expect(within(openai).getByText(/openai\/gpt-4\.1-mini/)).toBeInTheDocument()
    expect(within(openai).getByText(/128K context/)).toBeInTheDocument()

    // A provider the account has no key for is not there at all — the catalog decides the
    // list, not a hardcoded provider table.
    expect(
      within(screen.getByRole('listbox', { name: 'Models' })).queryByRole('group', {
        name: 'google',
      }),
    ).not.toBeInTheDocument()
  })

  it('offers only the providers with keys, and nothing hardcoded', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [OPENAI], providers: [status('openai')] })
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))

    expect(group('openai')).toBeInTheDocument()
    expect(
      within(screen.getByRole('listbox', { name: 'Models' })).queryByRole('group', {
        name: 'anthropic',
      }),
    ).not.toBeInTheDocument()
    // The old MODEL_SUGGESTIONS list is gone: no provider it named leaks into the screen.
    expect(screen.queryByText(/claude-opus-5-5|gemini-3-pro/)).not.toBeInTheDocument()
  })

  it('creates the session with the chosen model and opens it', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))
    await user.click(within(group('openai')).getByRole('option', { name: /GPT-4.1 mini/ }))
    expect(trigger()).toHaveTextContent('GPT-4.1 mini')

    await user.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    expect(creates).toEqual([{ model: { id: 'openai/gpt-4.1-mini' } }])
    // The chat opens on it: the header is headed by the model and shows its id.
    expect(await screen.findByRole('heading', { name: 'GPT-4.1 mini' })).toBeInTheDocument()
    expect(within(screen.getByRole('banner')).getByText('openai/gpt-4.1-mini')).toBeInTheDocument()
  })

  it('takes a free-text model id through "Other model ID…"', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    const creates = recordCreates(fake)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))
    await user.click(screen.getByRole('option', { name: /Other model ID/ }))
    await user.type(screen.getByLabelText('Model ID'), 'deepseek/deepseek-chat')
    await user.click(screen.getByRole('button', { name: 'Use model' }))

    expect(trigger()).toHaveTextContent('deepseek/deepseek-chat')
    await user.click(screen.getByRole('button', { name: 'Create chat' }))

    await waitFor(() => {
      expect(creates).toEqual([{ model: { id: 'deepseek/deepseek-chat' } }])
    })
  })

  it('is keyboard driven: arrows move, Enter picks, Escape closes', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/new' })

    const button = await screen.findByRole('button', { name: /Model/ })
    button.focus()
    await user.keyboard('{Enter}')

    // The combobox pattern: focus stays in the search field, the active option is announced.
    const search = screen.getByRole('combobox', { name: 'Search models' })
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('option', { name: /Claude Sonnet 5/ })).toHaveAttribute(
      'data-active',
      'true',
    )

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(button).toHaveTextContent('GPT-4.1 mini')
    expect(button).toHaveFocus()

    await user.click(button)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('searches by name and by id', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))
    await user.type(screen.getByRole('combobox', { name: 'Search models' }), 'gpt-4.1')

    expect(group('openai')).toBeInTheDocument()
    expect(
      within(screen.getByRole('listbox', { name: 'Models' })).queryByRole('group', {
        name: 'anthropic',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows the fallback note on a provider that came from the built-in list', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      models: [OPENAI],
      providers: [
        status('openai', {
          status: 'fallback',
          fetched_at: null,
          message: 'The provider timed out.',
        }),
      ],
    })
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))

    expect(
      within(group('openai')).getByText("from the built-in list; the provider couldn't be reached"),
    ).toBeInTheDocument()
  })

  it('refreshes with refresh: true', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: 'Refresh models' }))

    await waitFor(() => {
      expect(fake.modelListCalls).toEqual([{ refresh: false }, { refresh: true }])
    })
  })

  it('answers a rate-limited refresh with a note, not an error', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    const list = fake.models.list.bind(fake.models)
    fake.models.list = (params, options) =>
      params?.refresh === true
        ? Promise.reject(new ApiError(429, 'Refreshed too recently; try again in a minute.'))
        : list(params, options)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: 'Refresh models' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Refreshed too recently; try again in a minute.',
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The list it already had is still there and still usable.
    expect(trigger()).toHaveTextContent('Claude Sonnet 5')
  })

  it('remembers the last model used as the default for the next chat', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))
    await user.click(within(group('openai')).getByRole('option', { name: /GPT-4.1 mini/ }))
    await user.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })

    window.location.hash = '#/new'

    // Not the catalog's first entry (Claude Sonnet 5): the one the last chat was made with.
    await waitFor(() => {
      expect(trigger()).toHaveTextContent('GPT-4.1 mini')
    })
  })

  it('points at Settings when there are no keys at all', async () => {
    const fake = makeFake({ models: [] })
    renderApp(fake, { hash: '#/new' })

    expect(await screen.findByText('No model providers yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings → Model providers' })).toHaveAttribute(
      'href',
      '#/settings',
    )
    expect(screen.queryByRole('button', { name: 'Create chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('labels the new session with its model in the sidebar too', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/new' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))
    await user.click(within(group('openai')).getByRole('option', { name: /GPT-4.1 mini/ }))
    await user.click(screen.getByRole('button', { name: 'Create chat' }))
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/s\/sesn_/)
    })
    const sessionId = window.location.hash.replace('#/s/', '')

    await waitFor(() => {
      const row = sessionRows().find(
        (element) => element.querySelector('a')?.getAttribute('href') === `#/s/${sessionId}`,
      )
      expect(row).toBeDefined()
      expect(row).toHaveTextContent('GPT-4.1 mini')
      expect(row).toHaveTextContent('openai/gpt-4.1-mini')
    })
  })
})
