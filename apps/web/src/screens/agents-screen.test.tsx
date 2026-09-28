import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../test-support/render-app'

/** The agents screen: the list, and one form for creating and editing. */
describe('AgentsScreen', () => {
  it('lists the agents and suggests models for the free-text model field', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/agents' })

    // Scoped to the list: the sidebar shows the agent's name too, on its session.
    const list = within(await screen.findByRole('region', { name: 'Agent list' }))
    expect(list.getByText('Summarizer')).toBeInTheDocument()
    expect(list.getByText('anthropic/claude-sonnet-5')).toBeInTheDocument()

    const model = screen.getByLabelText('Model')
    const suggestionsId = model.getAttribute('list') ?? ''
    const suggestions = [...document.querySelectorAll(`#${suggestionsId} option`)].map((option) =>
      option.getAttribute('value'),
    )
    expect(suggestions).toContain('anthropic/claude-sonnet-5')
    expect(suggestions).toContain('openai/gpt-5.1')
  })

  it('creates an agent from the form', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/agents' })

    await user.type(await screen.findByLabelText('Name'), 'Summarizer 9000')
    await user.type(screen.getByLabelText('Model'), 'anthropic/claude-opus-5-5')
    await user.type(screen.getByLabelText('System prompt'), 'Be terse.')
    await user.click(screen.getByRole('button', { name: 'Create agent' }))

    await waitFor(async () => {
      const listed = await fake.agents.list()
      expect(listed.data.map((agent) => agent.name)).toContain('Summarizer 9000')
    })

    const created = (await fake.agents.list()).data.find(
      (agent) => agent.name === 'Summarizer 9000',
    )
    expect(created?.model.id).toBe('anthropic/claude-opus-5-5')
    expect(created?.system).toBe('Be terse.')

    // It shows up in the list, and the form is blank again for the next one.
    expect(await screen.findByText('Summarizer 9000')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('')
  })

  it('edits an agent in place', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    renderApp(fake, { hash: '#/agents' })

    await user.click(await screen.findByRole('button', { name: 'Edit Summarizer' }))

    const form = screen.getByRole('button', { name: 'Save changes' }).closest('form')
    expect(form).not.toBeNull()
    const fields = within(form as HTMLElement)

    await user.clear(fields.getByLabelText('Name'))
    await user.type(fields.getByLabelText('Name'), 'Renamed')
    await user.clear(fields.getByLabelText('Model'))
    await user.type(fields.getByLabelText('Model'), 'openai/gpt-5.1')
    await user.clear(fields.getByLabelText('System prompt'))
    await user.type(fields.getByLabelText('System prompt'), 'Say less.')
    await user.click(fields.getByRole('button', { name: 'Save changes' }))

    await waitFor(async () => {
      const listed = await fake.agents.list()
      const agent = listed.data.find((candidate) => candidate.id === fake.agent.id)
      expect(agent?.name).toBe('Renamed')
      expect(agent?.model.id).toBe('openai/gpt-5.1')
      expect(agent?.system).toBe('Say less.')
    })

    expect(await screen.findByText('Renamed')).toBeInTheDocument()
    expect(screen.getByText('Saved Renamed.')).toBeInTheDocument()
  })
})
