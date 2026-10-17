import { slashCommands } from '@openharness/client'
import { makeSkill } from '@openharness/protocol/fixtures'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ANTHROPIC, OPENAI, providerStatus } from '../../test-support/catalog'
import { ModelPicker } from '../models/model-picker'
import { Composer, type ComposerEdit } from './composer'

/**
 * The composer's keyboard path (issue #105, P1): Enter sends, Shift+Enter starts a new line,
 * an empty or whitespace-only body sends nothing, and Send is disabled while there is nothing
 * to send. These are the rules the whole chat rests on, and none of them had a test — every
 * chat test clicked the Send button.
 *
 * Written against the composer as it is now, model selector included (epic #116): the
 * selector is part of the input area, so it is part of what the keyboard tests render.
 *
 * Edit mode (#238) is the second thing the box owns: the indicator above it, Escape and
 * Cancel, and a send withheld while the screen says the rewind would be refused.
 */
function setup(
  onSend: (text: string) => boolean | void | Promise<boolean | void> = () => true,
  edit?: ComposerEdit,
  skills = [makeSkill({ name: 'release-notes' })],
) {
  const user = userEvent.setup({ delay: null })
  const send = vi.fn(onSend)
  render(
    <Composer
      running={false}
      onSend={send}
      onStop={vi.fn()}
      edit={edit}
      commands={slashCommands(skills)}
      modelSelector={
        <ModelPicker
          variant="compact"
          models={[ANTHROPIC, OPENAI]}
          providers={[providerStatus('anthropic'), providerStatus('openai')]}
          value={ANTHROPIC.id}
          onChange={() => undefined}
        />
      }
    />,
  )
  return {
    user,
    send,
    input: screen.getByLabelText('Message'),
    sendButton: screen.getByRole('button', { name: 'Send message' }),
  }
}

describe('Composer', () => {
  it('sends on Enter and clears the box', async () => {
    const { user, send, input } = setup()

    await user.type(input, 'hello there')
    await user.keyboard('{Enter}')

    expect(send).toHaveBeenCalledWith('hello there')
    expect(input).toHaveValue('')
  })

  it('starts a new line on Shift+Enter instead of sending', async () => {
    const { user, send, input } = setup()

    await user.type(input, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(input, 'line two')

    expect(send).not.toHaveBeenCalled()
    expect(input).toHaveValue('line one\nline two')
  })

  it('sends nothing for an empty or whitespace-only body', async () => {
    const { user, send, sendButton, input } = setup()

    // Empty: Enter and the disabled button both do nothing.
    await user.keyboard('{Enter}')
    await user.click(sendButton)
    expect(send).not.toHaveBeenCalled()

    // Whitespace is empty once it is trimmed, and the button says so.
    await user.type(input, '   ')
    expect(sendButton).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(send).not.toHaveBeenCalled()
  })

  it('disables Send while there is nothing to send, and enables it with text', async () => {
    const { user, sendButton, input } = setup()

    expect(sendButton).toBeDisabled()

    await user.type(input, 'hi')
    expect(sendButton).toBeEnabled()

    await user.clear(input)
    expect(sendButton).toBeDisabled()
  })

  it('keeps the text when the send was not stored', async () => {
    const { user, send, input, sendButton } = setup(() => false)

    await user.type(input, 'keep me')
    await user.click(sendButton)

    expect(send).toHaveBeenCalledWith('keep me')
    // The one moment losing what you wrote hurts most is the one where it did not go.
    expect(input).toHaveValue('keep me')
  })

  it('says what a send would do while editing, and leaves on Cancel (#238)', async () => {
    const onCancel = vi.fn()
    const { user } = setup(() => true, { blocked: false, onCancel })

    // The reader is told what pressing Send does before they press it: the messages after the
    // one being rewritten are about to be replaced.
    expect(
      screen.getByText('Editing message · sending replaces what follows it'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('leaves edit mode on Escape (#238)', async () => {
    const onCancel = vi.fn()
    const { user, input } = setup(() => true, { blocked: false, onCancel })

    await user.click(input)
    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('withholds a send the screen says would be refused, and says why (#238)', async () => {
    const { user, send, input, sendButton } = setup(() => true, {
      blocked: true,
      onCancel: vi.fn(),
    })

    await user.type(input, 'the rewrite')
    // The turn in flight owns the branch the rewind would replace, so the server would refuse
    // it (409): the box says what to wait for and offers no send — the button or Enter.
    expect(screen.getByText('Editing message · wait for the reply to finish')).toBeInTheDocument()
    expect(sendButton).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(send).not.toHaveBeenCalled()
    // And nothing was lost: the edit is still in the box, waiting for the turn to end.
    expect(input).toHaveValue('the rewrite')
  })

  it('opens the / menu on a slash and filters it as the reader types (#349, K7)', async () => {
    const { user, input } = setup()

    // Nothing is offered for an ordinary message.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.type(input, 'hello')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    // A bare slash opens it, with the built-in command and the reader's own skill in it — and
    // the row says what the command does.
    await user.clear(input)
    await user.type(input, '/')
    const menu = screen.getByRole('listbox', { name: 'Slash commands' })
    expect(menu).toBeInTheDocument()
    expect(screen.getByText('/compact [instructions]')).toBeInTheDocument()
    expect(screen.getByText('Summarize the older history now')).toBeInTheDocument()
    expect(screen.getByText('/release-notes <[version]>')).toBeInTheDocument()

    // A prefix narrows it; the skill has dropped out of the menu.
    await user.type(input, 'comp')
    expect(screen.getByText('/compact [instructions]')).toBeInTheDocument()
    expect(screen.queryByText('/release-notes <[version]>')).not.toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'true')

    // Clearing the box — and any line that is not a command — closes it.
    await user.clear(input)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.type(input, '/composing a thought')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('moves the highlight with the arrows and takes the row with Enter (K7)', async () => {
    const { user, input, send } = setup()

    await user.type(input, '/')
    const rows = screen.getAllByRole('option')
    expect(rows.map((row) => row.getAttribute('data-command'))).toEqual([
      'compact',
      'release-notes',
    ])
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')

    // The arrows wrap, so one Up from the first row is the last one.
    await user.keyboard('{ArrowDown}')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')

    // Enter takes the highlighted row: the box becomes `/name `, and nothing was sent.
    await user.keyboard('{Enter}')
    expect(input).toHaveValue('/release-notes ')
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('runs a built-in the box names in full on one Enter (#354)', async () => {
    const { user, input, send } = setup()

    await user.type(input, '/compact')
    // The menu is up with the built-in highlighted — and Enter runs it at once rather than
    // filling the box a second time, which is what a second Enter used to be needed for.
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Enter}')

    expect(send).toHaveBeenCalledWith('/compact')
    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('completes a fully-typed skill to `/name ` so its arguments can follow (#354)', async () => {
    const { user, input, send } = setup()

    await user.type(input, '/release-notes')
    await user.keyboard('{Enter}')

    // A skill is never run from the menu: it is sent as the message the invocation is, so Enter
    // leaves the box ready for the arguments.
    expect(input).toHaveValue('/release-notes ')
    expect(send).not.toHaveBeenCalled()

    await user.type(input, 'v1.2{Enter}')
    expect(send).toHaveBeenCalledWith('/release-notes v1.2')
  })

  it('shows the skill’s argument-hint as the placeholder once it is picked (K7)', async () => {
    const { user, input } = setup()

    await user.type(input, '/')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(input).toHaveValue('/release-notes ')
    expect(input).toHaveAttribute('placeholder', '[version]')

    // Typing the arguments is the end of the hint — and of the menu.
    await user.type(input, 'v1.2')
    expect(input).toHaveAttribute(
      'placeholder',
      'Send a message…  (Enter to send, Shift+Enter for a new line)',
    )
  })

  it('closes the menu on Escape without stopping the turn (K7)', async () => {
    const user = userEvent.setup({ delay: null })
    const send = vi.fn(() => true)
    const stop = vi.fn()
    render(
      <Composer
        running
        onSend={send}
        onStop={stop}
        commands={slashCommands([makeSkill({ name: 'release-notes' })])}
      />,
    )
    const input = screen.getByLabelText('Message')

    await user.type(input, '/')
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    // Escape closes the menu; the same key is Stop's everywhere else in the box, and the menu
    // is what the reader is looking at.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(stop).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('offers no menu for a line that names no command (#283)', async () => {
    const { user, input } = setup()

    await user.type(input, '/composing a thought')
    expect(screen.queryByText('/compact [instructions]')).not.toBeInTheDocument()
  })

  it('shows the model selector in the input area', async () => {
    const { user } = setup()

    const selector = screen.getByRole('button', { name: /Model: Claude Sonnet 5/ })
    // The app's own listbox, not a native select (#87).
    expect(selector).toHaveAttribute('aria-haspopup', 'listbox')

    await user.click(selector)
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeInTheDocument()
  })
})
