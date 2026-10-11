import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { frameOf, pressKey, typeText, waitForScreen } from '../test-support/input'
import { TextEntry } from './text-entry'

/**
 * The one-line entry the prompt slot's flows read text with (epic #303, #310).
 *
 * It echoes what is typed, settles with Enter, and settles `null` on Esc — which is what an
 * `ask_user` answer, a write-in or a denial's message needs.
 */

afterEach(() => {
  cleanup()
})

/** Render the entry and record what it settled with. */
async function show(initial = '') {
  const settled: (string | null)[] = []
  const instance = render(
    <TextEntry
      label="Which environment?"
      initial={initial}
      onSubmit={(text) => {
        settled.push(text)
      }}
      onCancel={() => {
        settled.push(null)
      }}
    />,
  )
  await waitForScreen(instance, 'Which environment?')
  return { ...instance, settled }
}

describe('TextEntry (#310)', () => {
  it('echoes what is typed and settles with it', async () => {
    const entry = await show()

    typeText(entry, 'staging')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frameOf(entry)).toContain('staging')

    pressKey(entry, 'enter')
    expect(entry.settled).toEqual(['staging'])
  })

  it('starts from what was said before, so it can be corrected', async () => {
    const entry = await show('staging')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frameOf(entry)).toContain('staging')

    pressKey(entry, 'backspace')
    typeText(entry, 'eu')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frameOf(entry)).toContain('stagineu')

    pressKey(entry, 'enter')
    expect(entry.settled).toEqual(['stagineu'])
  })

  it('settles nothing on Esc, or on Ctrl+C', async () => {
    const first = await show()
    pressKey(first, 'escape')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(first.settled).toEqual([null])

    const second = await show()
    pressKey(second, 'ctrlC')
    expect(second.settled).toEqual([null])
  })

  it('takes an empty line as an answer', async () => {
    const entry = await show('something')
    for (let step = 0; step < 'something'.length; step += 1) {
      pressKey(entry, 'backspace')
    }
    pressKey(entry, 'enter')
    expect(entry.settled).toEqual([''])
  })

  it('keeps a pasted line to one line', async () => {
    const entry = await show()
    typeText(entry, 'one')
    // A bracketed paste of several lines arrives as one string; a field of one line keeps it
    // on the line rather than inventing a second.
    entry.stdin.write('\u001B[200~two\nthree\u001B[201~')
    await new Promise((resolve) => setTimeout(resolve, 20))

    pressKey(entry, 'enter')
    expect(entry.settled).toEqual(['onetwo three'])
  })
})
