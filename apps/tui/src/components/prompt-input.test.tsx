import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChatCommand } from '../chat/commands'
import type { PromptHistory } from '../history'
import {
  frameOf,
  paste,
  pressKey,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
  type TestInstance,
} from '../test-support/input'
import { LARGE_PASTE_CHARS, PromptInput, promptLines } from './prompt-input'

/** A registry the menu assertions can talk about, two plain commands and one alias. */
const COMMANDS: readonly ChatCommand[] = [
  { name: 'model', description: 'pick a model', run: () => undefined },
  { name: 'new', description: 'start a new chat', run: () => undefined },
  { name: 'exit', aliases: ['quit'], description: 'leave the chat', run: () => undefined },
]

/** A history that is only a list: the file side is covered in `history.test.ts`. */
function fakeHistory(entries: readonly string[] = []): PromptHistory {
  const list = [...entries]
  return {
    path: '/tmp/oh-history-test/history.json',
    entries: () => list,
    add(text) {
      list.push(text)
    },
  }
}

/** Render the prompt and record what it submitted. */
function renderPrompt(history?: PromptHistory, commands?: readonly ChatCommand[]) {
  const submitted: string[] = []
  let activity = 0
  const instance = render(
    <PromptInput
      history={history}
      {...(commands === undefined ? {} : { commands })}
      onSubmit={(text) => {
        submitted.push(text)
      }}
      onActivity={() => {
        activity += 1
      }}
    />,
  )

  return { ...instance, submitted, activityCount: () => activity }
}

/** Render the prompt with the registry, the way the chat screen mounts it. */
function renderMenuPrompt(history?: PromptHistory) {
  return renderPrompt(history, COMMANDS)
}

type TestPrompt = TestInstance & { readonly submitted: string[]; activityCount: () => number }

/**
 * One line of the prompt's frame: line 0 is the `❯` marker's line, the rest are the buffer's.
 *
 * Ink trims the end of every rendered line, so a line the buffer left empty reads as `''` —
 * which is why this indexes the frame rather than matching a prefix.
 */
function promptLine(instance: TestPrompt, index = 0): string {
  return frameOf(instance).split('\n')[index] ?? ''
}

afterEach(() => {
  cleanup()
})

describe('PromptInput keys', () => {
  it('sends on Enter, and does not send an empty or whitespace-only buffer', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    pressKey(prompt, 'enter')
    typeText(prompt, '   ')
    pressKey(prompt, 'enter')
    expect(prompt.submitted).toEqual([])

    typeText(prompt, 'hello')
    pressKey(prompt, 'enter')

    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['hello'])
    // The buffer is cleared for the next message: what is left is the marker and the cursor.
    await waitFor(() => promptLine(prompt).trimEnd() === '❯')
  })

  it('inserts a newline with Ctrl+J and with Alt+Enter', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'first')
    pressKey(prompt, 'newline')
    typeText(prompt, 'second')
    await waitForScreen(prompt, '  second')
    expect(prompt.submitted).toEqual([])

    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['first\nsecond'])

    // Alt+Enter is the same key: `ESC` + `\r`, which Ink reports as Enter with meta.
    typeText(prompt, 'one')
    pressKey(prompt, 'altEnter')
    typeText(prompt, 'two')
    await waitForScreen(prompt, '  two')
    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 2)
    expect(prompt.submitted[1]).toBe('one\ntwo')
  })

  it('moves with ←/→ and inserts at the cursor', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'ac')
    pressKey(prompt, 'left')
    typeText(prompt, 'b')

    await waitForScreen(prompt, '❯ abc')
  })

  it('puts the cursor at the start of the line with Home and Ctrl+A', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'world')
    pressKey(prompt, 'home')
    typeText(prompt, 'hello ')
    await waitForScreen(prompt, '❯ hello world')

    // Ctrl+A does the same from further in.
    pressKey(prompt, 'end')
    typeText(prompt, '!')
    await waitForScreen(prompt, '❯ hello world!')
    pressKey(prompt, 'ctrlA')
    typeText(prompt, '>')
    await waitForScreen(prompt, '❯ >hello world!')
  })

  it('puts the cursor at the end of the line with End and Ctrl+E', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'ab')
    pressKey(prompt, 'home')
    pressKey(prompt, 'end')
    typeText(prompt, 'c')
    await waitForScreen(prompt, '❯ abc')

    pressKey(prompt, 'home')
    pressKey(prompt, 'ctrlE')
    typeText(prompt, 'd')
    await waitForScreen(prompt, '❯ abcd')
  })

  it('stops Home/End and Ctrl+A/Ctrl+E at the line, not the buffer', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'one')
    pressKey(prompt, 'newline')
    typeText(prompt, 'two')
    await waitForScreen(prompt, '  two')

    // The cursor is at the end of the second line; Ctrl+A goes to the start of *that* line.
    pressKey(prompt, 'ctrlA')
    typeText(prompt, 'X')
    await waitForScreen(prompt, '  Xtwo')

    pressKey(prompt, 'ctrlE')
    typeText(prompt, 'Y')
    await waitForScreen(prompt, '  XtwoY')
  })

  it('deletes behind with Backspace and at the cursor with Delete', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'abc')
    pressKey(prompt, 'backspace')
    await waitForScreen(prompt, '❯ ab')

    pressKey(prompt, 'home')
    pressKey(prompt, 'delete')
    await waitForScreen(prompt, '❯ b')

    // Backspace at the start of the buffer does nothing, and does not throw.
    pressKey(prompt, 'home')
    pressKey(prompt, 'backspace')
    await waitForScreen(prompt, '❯ b')
  })

  it('deletes to the start of the line with Ctrl+U and to its end with Ctrl+K', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'one')
    pressKey(prompt, 'newline')
    typeText(prompt, 'two three')
    await waitForScreen(prompt, '  two three')

    // Ctrl+U takes the second line back to its start and leaves the first one alone.
    pressKey(prompt, 'ctrlU')
    await waitFor(() => promptLine(prompt, 1).trim() === '')
    expect(frameOf(prompt)).toContain('❯ one')

    // Ctrl+K is the other half: from the start of the line, to its end.
    typeText(prompt, 'two three')
    await waitForScreen(prompt, '  two three')
    pressKey(prompt, 'ctrlA')
    pressKey(prompt, 'ctrlK')

    await waitFor(() => promptLine(prompt, 1).trim() === '')
    expect(frameOf(prompt)).toContain('❯ one')
  })

  it('deletes the previous word with Ctrl+W and Alt+Backspace', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'one two three')
    pressKey(prompt, 'ctrlW')
    await waitForScreen(prompt, '❯ one two')
    pressKey(prompt, 'altBackspace')
    await waitForScreen(prompt, '❯ one')

    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    // Only the words went: the space they left behind is still the buffer's, the way a
    // shell's readline leaves it.
    expect(prompt.submitted).toEqual(['one '])
  })

  it('has nothing to delete before the start of the buffer', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'kept')
    pressKey(prompt, 'home')
    pressKey(prompt, 'ctrlW')
    pressKey(prompt, 'altBackspace')
    pressKey(prompt, 'enter')

    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['kept'])
  })

  it('jumps a word with Alt+B, Alt+F and Ctrl+←, Ctrl+→', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    // Alt+B from the end of the buffer lands on the start of the last word.
    typeText(prompt, 'one two')
    pressKey(prompt, 'altB')
    typeText(prompt, 'X')
    await waitForScreen(prompt, '❯ one Xtwo')

    // Ctrl+→ is Alt+F: forward, over the word under the cursor.
    pressKey(prompt, 'ctrlRight')
    typeText(prompt, 'Y')
    await waitForScreen(prompt, '❯ one XtwoY')

    // Ctrl+← is Alt+B: back, to the start of the word behind.
    pressKey(prompt, 'ctrlLeft')
    typeText(prompt, 'Z')
    await waitForScreen(prompt, '❯ one ZXtwoY')

    pressKey(prompt, 'altF')
    typeText(prompt, 'W')
    await waitForScreen(prompt, '❯ one ZXtwoYW')
  })

  it('leaves Ctrl+C to the screen, and ignores Tab and Escape', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'kept')
    pressKey(prompt, 'ctrlC')
    pressKey(prompt, 'tab')
    pressKey(prompt, 'escape')

    await waitForScreen(prompt, '❯ kept')
    expect(prompt.submitted).toEqual([])
  })
})

describe('PromptInput history', () => {
  it('walks back through what was sent, newest first', async () => {
    const history = fakeHistory(['first', 'second'])
    const prompt = renderPrompt(history)
    await waitForScreen(prompt, '❯')

    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ second')

    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ first')

    // The oldest entry is the end of it: ↑ stays there.
    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ first')

    pressKey(prompt, 'down')
    await waitForScreen(prompt, '❯ second')
  })

  it('keeps the draft, and puts it back on the way down', async () => {
    const history = fakeHistory(['an old prompt'])
    const prompt = renderPrompt(history)
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'half-written')
    await waitForScreen(prompt, '❯ half-written')

    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ an old prompt')

    pressKey(prompt, 'down')
    await waitForScreen(prompt, '❯ half-written')
  })

  it('does nothing on ↓ at the draft, even with a history', async () => {
    const prompt = renderPrompt(fakeHistory(['an old prompt']))
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'mine')
    pressKey(prompt, 'down')

    await waitForScreen(prompt, '❯ mine')
  })

  it('leaves the arrows to the buffer while the buffer has lines to move between', async () => {
    const history = fakeHistory(['an old prompt'])
    const prompt = renderPrompt(history)
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'first')
    pressKey(prompt, 'newline')
    typeText(prompt, 'second')
    await waitForScreen(prompt, '  second')

    // ↑ is a line up, not a history step.
    pressKey(prompt, 'up')
    typeText(prompt, 'X')
    await waitForScreen(prompt, '❯ firstX')

    // …and from the first line it is the history.
    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ an old prompt')

    // ↓ comes back to the draft, not to the second line: the buffer is one thing.
    pressKey(prompt, 'down')
    await waitForScreen(prompt, '❯ firstX')

    // The draft came back whole, second line and all — and ↓ is the buffer's again.
    pressKey(prompt, 'down')
    pressKey(prompt, 'ctrlE')
    typeText(prompt, 'W')
    await waitForScreen(prompt, '  secondW')
  })

  it('records what was sent, so the next ↑ finds it', async () => {
    const history = fakeHistory()
    const prompt = renderPrompt(history)
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'remember me')
    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)

    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ remember me')
  })

  it('records the multi-line message as one entry', async () => {
    const history = fakeHistory()
    const prompt = renderPrompt(history)
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'one')
    pressKey(prompt, 'newline')
    typeText(prompt, 'two')
    await waitForScreen(prompt, '  two')
    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)

    pressKey(prompt, 'up')
    await waitForScreen(prompt, '❯ one')
    expect(frameOf(prompt)).toContain('  two')
  })

  it('walks a multi-line entry line by line once it is recalled', async () => {
    const history = fakeHistory(['one\ntwo'])
    const prompt = renderPrompt(history)
    await waitForScreen(prompt, '❯')

    pressKey(prompt, 'up')
    await waitForScreen(prompt, '  two')

    // The cursor is at the end of its last line, so ↑ is a line up first.
    pressKey(prompt, 'up')
    typeText(prompt, 'X')
    await waitForScreen(prompt, '❯ oneX')
  })

  it('leaves the arrows inert when there is no history at all', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, 'mine')
    pressKey(prompt, 'up')
    pressKey(prompt, 'down')

    await waitForScreen(prompt, '❯ mine')
  })
})

describe('PromptInput paste', () => {
  it('inserts a multi-line paste as one buffer, without sending on its newlines', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    // A terminal sends `\r` for the line endings inside a paste; the prompt turns them into
    // the buffer's own newline and never reads one as Enter.
    paste(prompt, 'first line\r\nsecond line\r')

    await waitForScreen(prompt, '❯ first line')
    await waitForScreen(prompt, '  second line')
    expect(prompt.submitted).toEqual([])

    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['first line\nsecond line\n'])
  })

  it('shows a very large paste collapsed, and sends all of it', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    const pasted = Array.from(
      { length: 40 },
      (_unused, index) => `line ${String(index).padStart(2, '0')} ${'x'.repeat(80)}`,
    ).join('\r\n')
    expect(pasted.length).toBeGreaterThan(LARGE_PASTE_CHARS)

    paste(prompt, pasted)

    await waitForScreen(prompt, '❯ [pasted 40 lines]')
    // The label stands in for the text; nothing of the text is on screen.
    expect(frameOf(prompt)).not.toContain('line 00')

    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted[0]).toBe(pasted.replace(/\r\n/gu, '\n'))
  })

  it('collapses a large single-line paste too, and names it in the singular', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    paste(prompt, 'y'.repeat(LARGE_PASTE_CHARS + 1))

    await waitForScreen(prompt, '❯ [pasted 1 line]')
  })

  it('keeps a paste under the limit as typed text', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    const pasted = 'z'.repeat(LARGE_PASTE_CHARS)
    paste(prompt, pasted)

    // A line this long wraps to the terminal's width, so the frame is the wrong place to
    // count characters: what matters is that no label stands in for it, and that the whole
    // paste is what is sent.
    await waitFor(() => frameOf(prompt).includes('zzzz'))
    expect(frameOf(prompt)).not.toContain('[pasted')

    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual([pasted])
  })

  it('deletes a collapsed paste as one run, and the text after it is still there', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    paste(prompt, 'y'.repeat(LARGE_PASTE_CHARS + 1))
    await waitForScreen(prompt, '❯ [pasted 1 line]')
    typeText(prompt, '!')
    await waitForScreen(prompt, '❯ [pasted 1 line]!')

    pressKey(prompt, 'backspace')
    await waitForScreen(prompt, '❯ [pasted 1 line]')

    pressKey(prompt, 'backspace')
    await waitForScreen(prompt, '❯')

    pressKey(prompt, 'enter')
    expect(prompt.submitted).toEqual([])
  })

  it('takes the whole paste when a deletion reaches into its label', async () => {
    const prompt = renderPrompt()
    await waitForScreen(prompt, '❯')

    paste(prompt, 'y'.repeat(LARGE_PASTE_CHARS + 1))
    typeText(prompt, ' after')
    await waitForScreen(prompt, '❯ [pasted 1 line] after')

    // Ctrl+U from the end takes the word, the label, and everything between.
    pressKey(prompt, 'ctrlU')
    await waitForScreen(prompt, '❯')
  })
})

describe('PromptInput command menu', () => {
  it('opens on a bare / and lists every command', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/')
    await waitForFrame(prompt, '❯ /model')

    const frame = frameOf(prompt)
    expect(frame).toContain('pick a model')
    expect(frame).toContain('/new')
    expect(frame).toContain('start a new chat')
    expect(frame).toContain('/exit (/quit)')
    expect(frame).toContain('leave the chat')
    // The one line that names the keys, so Tab and Esc are discoverable.
    expect(frame).toContain('Tab to complete')
  })

  it('filters as the command word is typed', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/')
    await waitForFrame(prompt, '❯ /model')
    typeText(prompt, 'ne')

    await waitForFrame(prompt, '❯ /new')
    await waitFor(() => !frameOf(prompt).includes('pick a model'), {
      describe: () => frameOf(prompt),
    })
  })

  it('leaves the arrows to the history when the query matches no command', async () => {
    const prompt = renderMenuPrompt(fakeHistory(['a previous prompt']))
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/zzz')
    pressKey(prompt, 'up')

    // ↑ is the history's again: no menu, so nothing takes the key from it.
    await waitForFrame(prompt, '❯ a previous prompt')
    expect(frameOf(prompt)).not.toContain('Tab to complete')
  })

  it('moves the highlight with ↑/↓, and never walks the history while it is up', async () => {
    const prompt = renderMenuPrompt(fakeHistory(['a previous prompt']))
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/')
    await waitForFrame(prompt, '❯ /model')
    pressKey(prompt, 'down')
    await waitForFrame(prompt, '❯ /new')
    pressKey(prompt, 'down')
    await waitForFrame(prompt, '❯ /exit (/quit)')
    pressKey(prompt, 'up')
    await waitForFrame(prompt, '❯ /new')

    // ↑ at the top of the list stays there; ↓ then lands on the second row, which is where
    // the highlight would be if the ↑ had gone into the history instead.
    pressKey(prompt, 'up')
    pressKey(prompt, 'up')
    pressKey(prompt, 'down')
    await waitForFrame(prompt, '❯ /new')

    expect(frameOf(prompt)).not.toContain('a previous prompt')
    expect(promptLine(prompt)).toBe('❯ /')
  })

  it('completes the highlighted command into the buffer on Tab', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/ne')
    await waitForFrame(prompt, 'start a new chat')
    pressKey(prompt, 'tab')
    // Completing leaves the menu closed — `/new` is a command, and a one-row list under it
    // is noise — so what Enter submits is the buffer: this is how the test tells the
    // completed `/new` from the `/ne` that was typed.
    await waitFor(() => !frameOf(prompt).includes('start a new chat'), {
      describe: () => frameOf(prompt),
    })
    pressKey(prompt, 'enter')

    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['/new'])
  })

  it('runs the highlighted command on Enter, not the half-typed name', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/ne')
    await waitForFrame(prompt, 'start a new chat')
    pressKey(prompt, 'enter')

    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['/new'])
  })

  it('closes once the typed name is a command in its own right', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/mo')
    await waitForFrame(prompt, 'pick a model')
    typeText(prompt, 'del')

    // `/model` needs no list: the line already says what it runs.
    await waitFor(() => !frameOf(prompt).includes('pick a model'), {
      describe: () => frameOf(prompt),
    })
    expect(promptLine(prompt)).toBe('❯ /model')
    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['/model'])
  })

  it('closes on Esc and keeps what is typed', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/ne')
    await waitForFrame(prompt, 'start a new chat')
    pressKey(prompt, 'escape')
    await waitFor(() => !frameOf(prompt).includes('start a new chat'), {
      describe: () => frameOf(prompt),
    })

    expect(promptLine(prompt)).toBe('❯ /ne')
    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    // Nothing was completed for it: an Esc'd `/ne` is the text the user typed, and the
    // screen is what decides that no command is called that.
    expect(prompt.submitted).toEqual(['/ne'])
  })

  it('closes once the command word is over, and types the rest as arguments', async () => {
    const prompt = renderMenuPrompt()
    await waitForScreen(prompt, '❯')

    typeText(prompt, '/ne')
    await waitForFrame(prompt, 'start a new chat')
    typeText(prompt, ' ')

    await waitFor(() => !frameOf(prompt).includes('start a new chat'), {
      describe: () => frameOf(prompt),
    })
    // The space is in the buffer (Ink trims it out of the frame, so Enter is what shows
    // it), and the menu left as soon as the command word was over.
    pressKey(prompt, 'enter')
    await waitFor(() => prompt.submitted.length === 1)
    expect(prompt.submitted).toEqual(['/ne '])
  })

  it('opens no menu without a registry, or for a line that is not a command', async () => {
    const plain = renderPrompt()
    await waitForScreen(plain, '❯')
    typeText(plain, '/')
    await waitForFrame(plain, '❯ /')
    expect(frameOf(plain)).not.toContain('Tab to complete')
    cleanup()

    // `//` is the escape hatch, and an ordinary message is none of the menu's business.
    const escaped = renderMenuPrompt()
    await waitForScreen(escaped, '❯')
    typeText(escaped, '//')
    typeText(escaped, 'hello')
    await waitForFrame(escaped, '❯ //hello')
    expect(frameOf(escaped)).not.toContain('Tab to complete')
  })
})

describe('promptLines', () => {
  it('marks the cursor cell, including at the end of the buffer', () => {
    expect(promptLines('abc', 0)).toEqual([{ text: 'abc', cursor: 0 }])
    expect(promptLines('abc', 1)).toEqual([{ text: 'abc', cursor: 1 }])
    // At the end the cursor is a cell of its own, past the last character.
    expect(promptLines('abc', 3)).toEqual([{ text: 'abc', cursor: 3 }])
  })

  it('marks the cursor on the right line of a multi-line buffer', () => {
    const lines = promptLines('one\ntwo', 6)
    expect(lines).toEqual([
      { text: 'one', cursor: null },
      { text: 'two', cursor: 2 },
    ])
  })

  it('draws an empty buffer as one line with the cursor on it', () => {
    expect(promptLines('', 0)).toEqual([{ text: '', cursor: 0 }])
  })

  it('draws a trailing newline as an empty last line', () => {
    expect(promptLines('one\n', 4)).toEqual([
      { text: 'one', cursor: null },
      { text: '', cursor: 0 },
    ])
  })
})

/**
 * The prompt while something else owns the keyboard (#310).
 *
 * A call waiting on the reader takes every key — the arrows and the space are its own — so the
 * prompt is drawn without listening until the flow hands the keys back. It hears nothing: not
 * characters, not Enter, not a paste.
 */
describe('PromptInput with the keyboard taken (#310)', () => {
  it('ignores keys, and takes them again once they are handed back', async () => {
    const submitted: string[] = []
    const instance = render(
      <PromptInput
        captureKeys={false}
        onSubmit={(text) => {
          submitted.push(text)
        }}
      />,
    )
    await waitForScreen(instance, '❯')

    typeText(instance, 'hello')
    pressKey(instance, 'enter')
    pressKey(instance, 'up')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(submitted).toEqual([])
    expect(frameOf(instance)).not.toContain('hello')

    // The same prompt with the keys back is an ordinary one again.
    const back = render(
      <PromptInput
        onSubmit={(text) => {
          submitted.push(text)
        }}
      />,
    )
    await waitForScreen(back, '❯')
    typeText(back, 'hello')
    pressKey(back, 'enter')
    await waitForFrame(back, '❯')
    expect(submitted).toContain('hello')
  })

  it('does not take a paste while the keys belong to something else', async () => {
    const submitted: string[] = []
    const instance = render(
      <PromptInput
        captureKeys={false}
        onSubmit={(text) => {
          submitted.push(text)
        }}
      />,
    )
    await waitForScreen(instance, '❯')

    paste(instance, 'pasted words')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frameOf(instance)).not.toContain('pasted')
    expect(submitted).toEqual([])
  })
})
