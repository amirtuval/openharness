import { ApiError } from '@openharness/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { modelEntry, providerStatus } from '../../test-support/catalog'
import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Settings → Context (epic #277, C3; #282).
 *
 * The card is three controls over one stored value, and these tests drive the app rather than
 * the card alone so a save goes through the real client and the fake's preferences row — the
 * same path the Default model and Appearance cards' tests take.
 *
 * The warning is the interesting half: it is the engine's own pass arithmetic
 * (`summaryModelFallback`), so the fixture's windows are chosen to make the count exact.
 */

/** The Context card, so a query cannot reach another card's control. */
async function card(): Promise<HTMLElement> {
  const title = await screen.findByText('Context')
  const element = title.closest('[data-slot="card"]')
  if (element === null) {
    throw new Error('the Context card is not in the document')
  }
  return element as HTMLElement
}

/** The stored preferences the fake currently holds. */
async function stored(fake: ReturnType<typeof makeFake>) {
  return await fake.preferences.get()
}

/** A chat model with a 200k window, and a summarizer with a tiny one. */
const BIG = modelEntry({
  id: 'anthropic/claude-sonnet-5',
  provider: 'anthropic',
  name: 'Claude Sonnet 5',
  context_window: 200_000,
})
const TINY = modelEntry({
  id: 'openai/gpt-4.1-mini',
  provider: 'openai',
  name: 'GPT-4.1 mini',
  context_window: 8_000,
  max_output_tokens: 2_000,
})

describe('the Context card', () => {
  it('shows the three controls, with the server’s default named', async () => {
    const fake = makeFake({
      models: [BIG, TINY],
      providers: [providerStatus('anthropic'), providerStatus('openai')],
      preferences: { default_model: 'anthropic/claude-sonnet-5' },
    })
    renderApp(fake, { hash: '#/settings' })

    const context = await card()
    // The threshold starts at the deployment's own share, which the response reported.
    expect(within(context).getByLabelText('Summarize at')).toHaveValue('0.7')
    expect(within(context).getByText('70%')).toBeInTheDocument()
    expect(within(context).getByText(/Server default: 70%/)).toBeInTheDocument()
    expect(within(context).getByText(/Currently following the server default/)).toBeInTheDocument()

    // The summary model starts at "Same as the chat", and the pass limit at the engine's default.
    expect(within(context).getByRole('button', { name: /^Summary model/ })).toHaveTextContent(
      'Same as the chat',
    )
    expect(within(context).getByLabelText('Summary pass limit')).toHaveValue(3)

    // Nothing is stored, so the "use the default" action is not offered.
    expect(within(context).queryByRole('button', { name: /Use the server default/ })).toBeNull()
  })

  it('saves a moved threshold, and clears it back to the server default', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [BIG, TINY] })
    renderApp(fake, { hash: '#/settings' })

    const context = await card()
    const slider = within(context).getByLabelText('Summarize at')
    fireEvent.change(slider, { target: { value: '0.5' } })
    fireEvent.pointerUp(slider)

    await waitFor(async () => {
      expect((await stored(fake)).compaction_threshold).toBe(0.5)
    })
    expect(await within(context).findByText('Summarize at 50%.')).toBeInTheDocument()

    // The choice is stored, so the card now offers the way back to the deployment's own share.
    await user.click(within(context).getByRole('button', { name: 'Use the server default' }))
    await waitFor(async () => {
      expect((await stored(fake)).compaction_threshold).toBeNull()
    })
    expect(within(context).getByText('70%')).toBeInTheDocument()
  })

  it('offers "Same as the chat" first, and saves both a model and the sentinel', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      models: [BIG, TINY],
      providers: [providerStatus('anthropic'), providerStatus('openai')],
    })
    renderApp(fake, { hash: '#/settings' })

    const context = await card()
    await user.click(within(context).getByRole('button', { name: /^Summary model/ }))

    // The pinned choice is the first option in the list, above the providers (K3).
    const listbox = screen.getByRole('listbox', { name: 'Models' })
    const options = within(listbox).getAllByRole('option')
    expect(options[0]).toHaveTextContent('Same as the chat')

    await user.click(within(listbox).getByRole('option', { name: /GPT-4.1 mini/ }))
    await waitFor(async () => {
      expect((await stored(fake)).summary_model).toBe('openai/gpt-4.1-mini')
    })
    expect(within(context).getByRole('button', { name: /^Summary model/ })).toHaveTextContent(
      'GPT-4.1 mini',
    )

    // And back: the sentinel is a value a reader can return to, not a reset to a blank.
    await user.click(within(context).getByRole('button', { name: /^Summary model/ }))
    await user.click(screen.getByRole('option', { name: /Same as the chat/ }))
    await waitFor(async () => {
      expect((await stored(fake)).summary_model).toBe('same-as-chat')
    })
  })

  it('saves a changed pass limit, and ignores one out of range', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ models: [BIG, TINY] })
    renderApp(fake, { hash: '#/settings' })

    const context = await card()
    const passes = within(context).getByLabelText('Summary pass limit')
    await user.clear(passes)
    await user.type(passes, '5')
    await user.tab()

    await waitFor(async () => {
      expect((await stored(fake)).summary_max_passes).toBe(5)
    })

    // 11 is over the bound: the control keeps what the server holds rather than sending it.
    await user.clear(passes)
    await user.type(passes, '11')
    await user.tab()
    expect((await stored(fake)).summary_max_passes).toBe(5)
  })

  it('warns, with the pass math, when the summary model is far smaller than the chat’s', async () => {
    const fake = makeFake({
      models: [BIG, TINY],
      providers: [providerStatus('anthropic'), providerStatus('openai')],
      preferences: {
        default_model: 'anthropic/claude-sonnet-5',
        summary_model: 'openai/gpt-4.1-mini',
      },
    })
    renderApp(fake, { hash: '#/settings' })

    // 150000 chat budget, a 6000-token summarizer folding 3000 a pass, a limit of 3: 50 passes.
    const warning = await screen.findByText(/over your limit of 3/)
    expect(warning).toHaveTextContent('about 50 passes')
    expect(warning).toHaveTextContent('anthropic/claude-sonnet-5')
  })

  it('says nothing when the summary model is wide enough for the pass limit', async () => {
    const fake = makeFake({
      models: [BIG],
      providers: [providerStatus('anthropic')],
      preferences: {
        default_model: 'anthropic/claude-sonnet-5',
        summary_model: 'anthropic/claude-sonnet-5',
      },
    })
    renderApp(fake, { hash: '#/settings' })

    const context = await card()
    expect(within(context).getByRole('button', { name: /^Summary model/ })).toBeInTheDocument()
    expect(screen.queryByText(/over your limit of/)).toBeNull()
  })

  it('shows a failed save inline, with the stored value still in effect', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({
      models: [BIG],
      providers: [providerStatus('anthropic')],
    })
    fake.preferences.put = () => Promise.reject(new ApiError(500, 'The preferences store is down.'))
    renderApp(fake, { hash: '#/settings' })

    const context = await card()
    const passes = within(context).getByLabelText('Summary pass limit')
    await user.clear(passes)
    await user.type(passes, '5')
    await user.tab()

    const title = await screen.findByText('Could not save the context settings')
    expect(title.closest('[role="alert"]')).toHaveTextContent('The preferences store is down.')
    // The write never landed, so the limit on screen is still the stored one.
    expect(within(context).getByLabelText('Summary pass limit')).toHaveValue(3)
  })
})
