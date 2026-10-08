import { ApiError } from '@openharness/client'
import type { FakeClient } from '@openharness/client/testing'
import { createFakeClient } from '@openharness/client/testing'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { App } from '../App'
import { SETTINGS_STORAGE_KEY, getSettings } from '../lib/settings'
import { TWO_PROVIDERS, modelEntry } from '../test-support/catalog'
import { makeFake, renderApp } from '../test-support/render-app'

/**
 * Settings, in the order #209 gave it: Providers, Default model, Appearance, Usage (#247), and
 * Advanced — collapsed — last. The card tests live with the cards
 * (`components/settings/providers.test.tsx`, `components/settings/appearance.test.tsx`); what is
 * here is the screen itself, plus what the Usage card reads.
 */
describe('SettingsScreen', () => {
  it('lays the sections out in order, with Advanced collapsed', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/settings' })

    const headings = await screen.findAllByRole('heading', { level: 1 })
    expect(headings.map((heading) => heading.textContent)).toEqual(['Settings'])

    // The four sections, in the order a reader needs them (X5), and the provider key — the
    // thing everyone needs — is no longer below a developer-only card.
    const titles = (
      await Promise.all(
        ['Providers', 'Default model', 'Appearance', 'Usage', 'Advanced'].map((name) =>
          screen.findByText(name),
        ),
      )
    ).map((element) => element.textContent)
    expect(titles).toEqual(['Providers', 'Default model', 'Appearance', 'Usage', 'Advanced'])

    // Collapsed by default: the trigger says so, and the section's own field is not in the DOM
    // at all — a collapsed section must not hold a focusable field.
    const trigger = screen.getByRole('button', { name: /Advanced/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument()
  })

  it('opens Advanced on demand, and closes it again', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake(TWO_PROVIDERS), { hash: '#/settings' })

    const trigger = await screen.findByRole('button', { name: /Advanced/ })
    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByLabelText('Server URL')).toBeInTheDocument()

    await user.click(trigger)
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument()
  })

  it('starts from the defaults and says an empty URL means this origin', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake(TWO_PROVIDERS), { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: /Advanced/ }))

    expect(await screen.findByLabelText('Server URL')).toHaveValue('')
    expect(screen.getByLabelText('Server URL')).toHaveAttribute(
      'placeholder',
      `(same origin: ${window.location.origin})`,
    )
  })

  it('keeps the save confirmation when the rebuilt client re-checks the session', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake(TWO_PROVIDERS)
    const first = renderApp(fake, { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: /Advanced/ }))
    // A first-time save: the field was empty, so the URL really changes — which, in the app,
    // rebuilds the client from it (`App`'s `useMemo`) and re-runs the session check for the
    // new one, because another server means another session (issue #81).
    await user.type(await screen.findByLabelText('Server URL'), 'http://localhost:8787')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved — the next request uses it.')).toBeInTheDocument()

    // The rebuild, with the new client's `me()` held open so the frame is asserted while the
    // re-check is in flight rather than after it.
    const rebuilt = createFakeClient()
    let answer: (() => void) | undefined
    rebuilt.me = () =>
      new Promise((resolve) => {
        answer = () => {
          resolve(rebuilt.user)
        }
      })
    first.rerender(<App client={rebuilt} />)

    // The re-check must not replace the frame: "Checking your session…" would unmount
    // Settings and drop the confirmation with it.
    expect(screen.queryByText('Checking your session…')).not.toBeInTheDocument()
    expect(screen.getByText('Saved — the next request uses it.')).toBeInTheDocument()

    answer?.()

    // And it survives the answer too: the screen was never remounted. (Advanced is collapsed
    // again, as a fresh mount leaves it — its state is not persisted anywhere.)
    expect(await screen.findByRole('button', { name: /Advanced/ })).toBeInTheDocument()
    expect(screen.getByText('Saved — the next request uses it.')).toBeInTheDocument()
  })

  it('saves the server URL to localStorage under the settings key', async () => {
    const user = userEvent.setup({ delay: null })
    renderApp(makeFake(TWO_PROVIDERS), { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: /Advanced/ }))
    await user.type(await screen.findByLabelText('Server URL'), 'http://localhost:8787')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
    await waitFor(() => {
      expect(getSettings()).toEqual({ serverUrl: 'http://localhost:8787' })
    })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify({ serverUrl: 'http://localhost:8787' }),
    )
  })

  it('opens with what a previous visit saved, and can clear the URL back to same-origin', async () => {
    const user = userEvent.setup({ delay: null })
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ serverUrl: 'https://api.example.com' }),
    )
    // Not `makeFake()`: this test wants what is already in `localStorage` to survive.
    const fake = createFakeClient()

    renderApp(fake, { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: /Advanced/ }))
    expect(await screen.findByLabelText('Server URL')).toHaveValue('https://api.example.com')

    await user.clear(screen.getByLabelText('Server URL'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(getSettings().serverUrl).toBe('')
    })
  })

  it('shows the list error on the Providers card, and the default-model error on its own', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    fake.providerCredentials.list = () =>
      Promise.reject(new ApiError(500, 'The key store is down.'))
    fake.preferences.get = () => Promise.reject(new ApiError(500, 'The preferences store is down.'))
    renderApp(fake, { hash: '#/settings' })

    const keys = await screen.findByText('Could not load your provider keys')
    expect(keys.closest('[role="alert"]')).toHaveTextContent('The key store is down.')
    const model = await screen.findByText('Could not load your default model')
    expect(model.closest('[role="alert"]')).toHaveTextContent('The preferences store is down.')
  })

  it('shows the default the server chose, and saves a new one', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      ...TWO_PROVIDERS,
      preferences: { default_model: 'anthropic/claude-sonnet-5' },
    })
    renderApp(fake, { hash: '#/settings' })

    // The automatic pick of U4 is a value like any other: the card reads it, it does not
    // decide it, so what is in effect is what is shown.
    const picker = await screen.findByRole('button', { name: /Model/ })
    expect(picker).toHaveTextContent('Claude Sonnet 5')

    await user.click(picker)
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))

    expect(await screen.findByText('Saved the default model.')).toBeInTheDocument()
    await waitFor(async () => {
      expect((await fake.preferences.get()).default_model).toBe('openai/gpt-4.1-mini')
    })
    expect(picker).toHaveTextContent('GPT-4.1 mini')
  })

  it('shows a default the catalog does not list as its id', async () => {
    const fake = makeFake({
      ...TWO_PROVIDERS,
      preferences: { default_model: 'deepseek/deepseek-chat' },
    })
    renderApp(fake, { hash: '#/settings' })

    // Free-text ids are allowed (U1): a default may be a model the catalog has never heard of.
    expect(await screen.findByRole('button', { name: /Model/ })).toHaveTextContent(
      'deepseek/deepseek-chat',
    )
  })

  it('shows a failed save inline, with the stored default still in effect', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      ...TWO_PROVIDERS,
      preferences: { default_model: 'anthropic/claude-sonnet-5' },
    })
    fake.preferences.put = () => Promise.reject(new ApiError(500, 'The preferences store is down.'))
    renderApp(fake, { hash: '#/settings' })

    await user.click(await screen.findByRole('button', { name: /Model/ }))
    await user.click(screen.getByRole('option', { name: /GPT-4.1 mini/ }))

    const title = await screen.findByText('Could not save the default model')
    expect(title.closest('[role="alert"]')).toHaveTextContent('The preferences store is down.')
    // The write never landed, so the server's default is still the one on screen.
    expect(screen.getByRole('button', { name: /Model/ })).toHaveTextContent('Claude Sonnet 5')
  })

  it('shows a failed load, and the picker still lets a default be chosen', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    fake.preferences.get = () => Promise.reject(new ApiError(500, 'The preferences store is down.'))
    renderApp(fake, { hash: '#/settings' })

    const title = await screen.findByText('Could not load your default model')
    expect(title.closest('[role="alert"]')).toHaveTextContent('The preferences store is down.')
    expect(screen.getByRole('button', { name: /Model/ })).toBeInTheDocument()
  })

  it('keeps the default-model picker out of the collapsed Advanced section', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    renderApp(fake, { hash: '#/settings' })

    // The two controls that look alike — the Default model picker and the picker inside the
    // first-run confirmation — are different components on different screens; here there is
    // exactly one, and it is the card's.
    const pickers = await screen.findAllByRole('button', { name: /^Model/ })
    expect(pickers).toHaveLength(1)
    expect(within(pickers[0] as HTMLElement).getByText('Choose a model')).toBeInTheDocument()
  })
})

describe('Settings → Usage (#247)', () => {
  /** A catalog whose one model is priced like the real Sonnet, so a cost is a number. */
  const PRICED = {
    models: [
      modelEntry({
        id: 'anthropic/claude-sonnet-5',
        provider: 'anthropic',
        name: 'Claude Sonnet 5',
        cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
      }),
    ],
  }

  /** A fake with one finished turn behind it: 512 input and 32 output tokens. */
  async function fakeWithATurn(options: Parameters<typeof makeFake>[0] = {}): Promise<FakeClient> {
    const fake = makeFake(options)
    fake.respondWith('Hello there.')
    await fake.sendMessage(fake.session.id, 'Hi there')
    await fake.waitForIdle(fake.session.id)
    return fake
  }

  it('reads this month from the caller’s own days, priced with the catalog’s rates', async () => {
    renderApp(await fakeWithATurn(PRICED), { hash: '#/settings' })

    // The total: 512 tokens at $2/Mtok and 32 at $10/Mtok, once. The same money is in the
    // model row beside it, which is the number the total is a sum of.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="usage-total"]')).not.toBeNull()
    })
    const total = document.querySelector('[data-slot="usage-total"]') as HTMLElement
    expect(within(total).getByText('$0.0013')).toBeInTheDocument()
    // The caption is this month so far, and says what the money bought.
    const caption = document.querySelector('[data-slot="usage-total"]')?.textContent ?? ''
    expect(caption).toContain('512')
    expect(caption).toContain('32')
    expect(caption).toContain('tokens ·')

    // By model: one row, one request, the same tokens — and the same money.
    const models = document.querySelector('[data-slot="usage-models"]') as HTMLElement
    expect(within(models).getByText('1')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="usage-model-cost"]')?.textContent).toBe('$0.0013')

    // By day: today, in the reader's own zone — the day the fake's clock named.
    expect(document.querySelector('[data-slot="usage-days"]')).not.toBeNull()
  })

  it('shows a dash when the model has no published price, and tokens all the same', async () => {
    const fake = await fakeWithATurn({
      models: [modelEntry({ id: 'acme/mystery-1', provider: 'acme', name: 'Mystery' })],
    })
    renderApp(fake, { hash: '#/settings' })

    // The tokens are real and the money is unknown: `—` in the total and in the row, never
    // `$0.00`, which would read as free.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="usage-total"]')).not.toBeNull()
    })
    const total = document.querySelector('[data-slot="usage-total"]') as HTMLElement
    expect(within(total).getByText('—')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="usage-model-cost"]')?.textContent).toBe('—')
  })

  it('says nothing has run rather than showing an empty table', async () => {
    renderApp(makeFake(TWO_PROVIDERS), { hash: '#/settings' })

    expect(await screen.findByText('Nothing has run this month.')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="usage-days"]')).toBeNull()
  })

  it('shows a failed read as one line, with the server’s own words', async () => {
    const fake = makeFake(TWO_PROVIDERS)
    // The card asks with the browser's zone, so a refusal is what a broken zone looks like:
    // the hook reads what the server answered, and the card shows it.
    fake.usage.me = () => Promise.reject(new ApiError(400, 'tz must be an IANA time zone name'))
    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByText('Could not load your usage')).toBeInTheDocument()
  })
})
