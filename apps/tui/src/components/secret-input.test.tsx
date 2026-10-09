import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { frameOf, paste, pressKey, typeText, waitFor, waitForFrame } from '../test-support/input'
import { SECRET_MASK, SecretInput } from './secret-input'

/** A key that is obviously not a real one — every capture and frame in the suite uses it. */
const KEY = 'sk-test-0000'

/** Render the input and record what it was asked to submit or cancel. */
function renderInput(
  options: {
    readonly placeholder?: string
    readonly onChar?: (c: string) => boolean
    readonly optional?: boolean
  } = {},
) {
  const submitted: string[] = []
  let cancelled = 0
  const instance = render(
    <SecretInput
      placeholder={options.placeholder}
      onChar={options.onChar}
      optional={options.optional}
      onSubmit={(value) => {
        submitted.push(value)
      }}
      onCancel={() => {
        cancelled += 1
      }}
    />,
  )

  return { ...instance, submitted, cancelled: () => cancelled }
}

afterEach(() => {
  cleanup()
})

describe('SecretInput', () => {
  it('does not echo what is typed — it masks it, character for character', async () => {
    const input = renderInput()

    typeText(input, KEY)

    await waitForFrame(input, SECRET_MASK.repeat(KEY.length))
    // The property the whole flow rests on: the characters are nowhere in the frame, and the
    // mask is exactly as long as what was typed, so the reader can still see their input.
    const frame = frameOf(input)
    expect(frame).not.toContain(KEY)
    expect(frame).not.toContain('sk-test')
    expect(frame).toContain(SECRET_MASK.repeat(KEY.length))
  })

  it('shows the placeholder while it is empty, and drops it on the first keystroke', async () => {
    const input = renderInput({ placeholder: 'sk-ant-…' })

    await waitForFrame(input, 'sk-ant-…')
    typeText(input, 'a')
    await waitForFrame(input, SECRET_MASK)
    expect(frameOf(input)).not.toContain('sk-ant-…')
  })

  it('submits the whole value on Enter, and never an empty one', async () => {
    const input = renderInput()

    pressKey(input, 'enter')
    await waitForFrame(input, '❯')
    expect(input.submitted).toEqual([])

    typeText(input, KEY)
    pressKey(input, 'enter')
    await waitForFrame(input, '❯')
    expect(input.submitted).toEqual([KEY])
  })

  it('submits an empty value when the field is optional (#249)', async () => {
    // A custom endpoint's key may be absent: Enter on the empty box is the answer "", not a
    // prompt that ignores the keypress and looks stuck.
    const input = renderInput({ optional: true })

    pressKey(input, 'enter')
    await waitFor(() => input.submitted.length === 1)
    expect(input.submitted).toEqual([''])
  })

  it('trims the whitespace a copied key usually carries', () => {
    const input = renderInput()

    typeText(input, `  ${KEY}  `)
    pressKey(input, 'enter')

    expect(input.submitted).toEqual([KEY])
  })

  it('backspace deletes the last character', async () => {
    const input = renderInput()

    typeText(input, 'abc')
    await waitForFrame(input, SECRET_MASK.repeat(3))
    pressKey(input, 'backspace')
    await waitForFrame(input, SECRET_MASK.repeat(2))
    expect(frameOf(input)).not.toContain(SECRET_MASK.repeat(3))

    pressKey(input, 'enter')
    expect(input.submitted).toEqual(['ab'])
  })

  it('takes a bracketed paste as one value — the normal way a key arrives', async () => {
    const input = renderInput()

    paste(input, KEY)

    await waitForFrame(input, SECRET_MASK.repeat(KEY.length))
    expect(frameOf(input)).not.toContain(KEY)

    pressKey(input, 'enter')
    expect(input.submitted).toEqual([KEY])
  })

  it('strips a pasted line ending rather than submitting on it', async () => {
    const input = renderInput()

    // A key copied out of a console often comes with its newline; it is not a submit.
    paste(input, `${KEY}\n`)
    await waitForFrame(input, SECRET_MASK.repeat(KEY.length))

    expect(input.submitted).toEqual([])
    pressKey(input, 'enter')
    expect(input.submitted).toEqual([KEY])
  })

  it('Esc cancels, and the value is forgotten', async () => {
    const input = renderInput()

    typeText(input, KEY)
    await waitForFrame(input, SECRET_MASK.repeat(KEY.length))
    pressKey(input, 'escape')
    await waitFor(() => input.cancelled() === 1)

    expect(frameOf(input)).toContain('❯')
    // Back to empty: a masked length left over would misreport what is in the box.
    pressKey(input, 'enter')
    expect(input.submitted).toEqual([])
  })

  it('gives the flow first refusal on a character it binds (o)', async () => {
    const input = renderInput({ onChar: (character) => character === 'o' })

    typeText(input, 'o')
    await waitForFrame(input, '❯')
    // Handled by the flow, so it is not part of the secret.
    expect(input.cancelled()).toBe(0)
    // The handler is asked about every character; one it does not claim is inserted.
    typeText(input, 'k')
    pressKey(input, 'enter')
    expect(input.submitted).toEqual(['k'])
  })

  it('stops asking once a key is being typed, so a typed key keeps its own letters', async () => {
    let claimed = 0
    const input = renderInput({
      onChar: (character) => {
        if (character !== 'o') return false
        claimed += 1
        return true
      },
    })

    // One character at a time, as typing by hand (or a paste without bracketed paste) sends it.
    typeText(input, 'sk-foo-0')
    await waitForFrame(input, SECRET_MASK.repeat(8))
    pressKey(input, 'enter')

    expect(input.submitted).toEqual(['sk-foo-0'])
    expect(claimed).toBe(0)
  })
})
