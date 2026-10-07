import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { commandUsageWidth, type ChatCommand } from '../chat/commands'
import { frameOf, waitForFrame } from '../test-support/input'
import { CommandMenu } from './command-menu'

/** A registry with everything a row can carry: a plain name, arguments, and an alias. */
const COMMANDS: readonly ChatCommand[] = [
  { name: 'model', description: 'pick a model', run: () => undefined },
  { name: 'mode', description: 'pick a mode', args: '<mode>', run: () => undefined },
  { name: 'exit', aliases: ['quit'], description: 'leave', run: () => undefined },
]

/** The width the prompt passes down: the registry's, never the filtered list's. */
const WIDTH = commandUsageWidth(COMMANDS)

/** The frame's lines, which is what a person reads. */
function linesOf(frame: string): readonly string[] {
  return frame.split('\n')
}

afterEach(() => {
  cleanup()
})

describe('CommandMenu', () => {
  it('draws every row, with its alias and its arguments', async () => {
    const menu = render(<CommandMenu commands={COMMANDS} selected={0} width={WIDTH} />)
    await waitForFrame(menu, 'pick a model')

    const [first, second, third] = linesOf(frameOf(menu))
    expect(first).toBe(`❯ ${'/model'.padEnd(WIDTH)}  pick a model`)
    expect(second).toBe(`  ${'/mode <mode>'.padEnd(WIDTH)}  pick a mode`)
    expect(third).toBe(`  ${'/exit (/quit)'.padEnd(WIDTH)}  leave`)
  })

  it('marks the selected row, and only it', async () => {
    const menu = render(<CommandMenu commands={COMMANDS} selected={1} width={WIDTH} />)
    await waitForFrame(menu, 'pick a mode')

    const lines = linesOf(frameOf(menu))
    expect(lines[0]?.startsWith('  /model')).toBe(true)
    expect(lines[1]?.startsWith('❯ /mode')).toBe(true)
    expect(lines[2]?.startsWith('  /exit')).toBe(true)
  })

  it('pads to the width it is given, so the column does not move as the list filters', async () => {
    const menu = render(<CommandMenu commands={[COMMANDS[0]!]} selected={0} width={WIDTH} />)
    await waitForFrame(menu, 'pick a model')

    // One row, filtered out of a longer registry: its description still starts where the
    // longer list's did.
    expect(linesOf(frameOf(menu))[0]).toBe(`❯ ${'/model'.padEnd(WIDTH)}  pick a model`)
  })

  it('names the keys that drive it', async () => {
    const menu = render(<CommandMenu commands={COMMANDS} selected={0} width={WIDTH} />)
    await waitForFrame(menu, 'Tab to complete')

    expect(frameOf(menu)).toContain('Esc to close')
  })
})
