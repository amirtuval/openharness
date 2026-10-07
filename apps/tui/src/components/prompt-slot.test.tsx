import { Box, Text, useInput } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  frameOf,
  pressKey,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
} from '../test-support/input'
import { usePromptSlot, type PromptSlot } from './prompt-slot'

/**
 * What the chat screen is, for this file: a prompt that the slot may replace, and one key
 * ("f") that starts the next flow — which is the only way a flow can start, because an event
 * handler is where a request belongs.
 */
function Harness({
  labels,
  results,
}: {
  readonly labels: readonly string[]
  readonly results: string[]
}) {
  const slot = usePromptSlot()
  const [started, setStarted] = useState(0)

  useInput((input) => {
    if (input !== 'f' || started >= labels.length) return
    const label = labels[started] ?? ''
    setStarted(started + 1)
    void flow(slot, label).then((result) => {
      results.push(`${label}:${result}`)
    })
  })

  return <Box flexDirection="column">{slot.element ?? <Text>prompt ❯</Text>}</Box>
}

/** One flow, whatever the caller starts: two steps, then a result. */
function flow(slot: PromptSlot, label: string): Promise<string> {
  return slot.request<string>((settle) => (
    // The key is the flow's own: replacing a flow has to make React mount a new one, or the
    // element would be re-rendered with the new props and the old component's state.
    <Steps key={label} label={label} settle={settle} />
  ))
}

/** A two-step flow: Enter once to move on, again to settle. */
function Steps({
  label,
  settle,
}: {
  readonly label: string
  readonly settle: (result: string) => void
}) {
  const [step, setStep] = useState(0)

  useInput((_input, key) => {
    if (!key.return) return
    if (step === 0) {
      setStep(1)
      return
    }
    settle('answered')
  })

  return <Text>{`${label} step ${String(step + 1)}`}</Text>
}

afterEach(() => {
  cleanup()
})

describe('usePromptSlot', () => {
  it('takes the input area for as long as a flow runs, and gives it back with a result', async () => {
    const results: string[] = []
    const screen = render(<Harness labels={['A']} results={results} />)
    await waitForScreen(screen, 'prompt ❯')

    typeText(screen, 'f')
    await waitForFrame(screen, 'A step 1')
    // The prompt is not drawn while the flow is up — which is also why the flow owns the
    // keys: there is nothing behind it to type into.
    expect(frameOf(screen)).not.toContain('prompt ❯')

    // Two steps, one request: how many there are is the flow's business, not the slot's.
    pressKey(screen, 'enter')
    await waitForFrame(screen, 'A step 2')
    pressKey(screen, 'enter')

    await waitFor(() => results.length === 1)
    expect(results).toEqual(['A:answered'])
    await waitForFrame(screen, 'prompt ❯')
  })

  it('starts nothing until a flow is asked for', async () => {
    const screen = render(<Harness labels={[]} results={[]} />)
    await waitForScreen(screen, 'prompt ❯')

    typeText(screen, 'f')

    expect(frameOf(screen)).toContain('prompt ❯')
  })

  it('replaces a flow that is already up, and settles only the one that answered', async () => {
    const results: string[] = []
    const screen = render(<Harness labels={['A', 'B']} results={results} />)
    await waitForScreen(screen, 'prompt ❯')

    typeText(screen, 'f')
    await waitForFrame(screen, 'A step 1')
    typeText(screen, 'f')
    await waitForFrame(screen, 'B step 1')

    pressKey(screen, 'enter')
    await waitForFrame(screen, 'B step 2')
    pressKey(screen, 'enter')

    // The first flow's promise never settles: nothing answered it, and the slot has no
    // honest value to settle it with.
    await waitForFrame(screen, 'prompt ❯')
    expect(results).toEqual(['B:answered'])
  })
})
