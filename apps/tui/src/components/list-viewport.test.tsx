import { Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'

import { frameOf, pressKey, waitForFrame } from '../test-support/input'
import {
  DEFAULT_TERMINAL_ROWS,
  MIN_VIEWPORT_ROWS,
  ScrollingList,
  listJump,
  listWindow,
  moreMarker,
  viewportRows,
} from './list-viewport'

describe('listWindow', () => {
  it('shows a short list whole, with no markers and no scrolling', () => {
    expect(listWindow(0, 3, 10)).toEqual({ first: 0, count: 3, above: 0, below: 0, index: 0 })
    expect(listWindow(2, 3, 10)).toEqual({ first: 0, count: 3, above: 0, below: 0, index: 2 })
    expect(listWindow(0, 0, 10)).toEqual({ first: 0, count: 0, above: 0, below: 0, index: 0 })
  })

  it('keeps the cursor in frame at the top and past the bottom', () => {
    // Cursor on the first row: the window is pressed against the start of the list.
    expect(listWindow(0, 60, 10)).toEqual({ first: 0, count: 10, above: 0, below: 50, index: 0 })
    // Cursor on the last row: the window is pressed against the end.
    expect(listWindow(59, 60, 10)).toEqual({ first: 50, count: 10, above: 50, below: 0, index: 59 })
    // In the middle the window follows the cursor, which stays in frame.
    const middle = listWindow(30, 60, 10)
    expect(middle.first).toBe(25)
    expect(middle.index).toBeGreaterThanOrEqual(middle.first)
    expect(middle.index).toBeLessThan(middle.first + middle.count)
  })

  it('clamps a cursor that is off the end of a list that just got shorter', () => {
    // A read answers with two servers where there were sixty: the cursor must not point past
    // the end, and the frames below must still be drawn from a real index.
    expect(listWindow(42, 2, 10)).toEqual({ first: 0, count: 2, above: 0, below: 0, index: 1 })
    expect(listWindow(-3, 5, 2).index).toBe(0)
  })

  it('never asks for a window of no rows', () => {
    expect(listWindow(0, 60, 0).count).toBe(1)
  })
})

describe('viewportRows', () => {
  it('is the terminal height less the chrome, over a floor', () => {
    expect(viewportRows(24, 6)).toBe(18)
    expect(viewportRows(40, 6)).toBe(34)
    // A terminal shorter than its own chrome still shows the floor, so the markers that say
    // there is more are on screen.
    expect(viewportRows(4, 8)).toBe(MIN_VIEWPORT_ROWS)
    // A stdout that reports no height at all is a test frame or a pipe.
    expect(viewportRows(undefined, 0)).toBe(DEFAULT_TERMINAL_ROWS)
    expect(viewportRows(0, 0)).toBe(DEFAULT_TERMINAL_ROWS)
  })
})

describe('moreMarker', () => {
  it('counts what is out of sight, and says nothing when there is none', () => {
    expect(moreMarker('above', 12)).toBe('↑ 12 more')
    expect(moreMarker('below', 1)).toBe('↓ 1 more')
    expect(moreMarker('above', 0)).toBeNull()
    expect(moreMarker('below', -1)).toBeNull()
  })
})

describe('listJump', () => {
  const page = 10

  it('moves a page at a time and stops at the ends', () => {
    expect(listJump(0, 60, { pageDown: true }, page)).toBe(10)
    expect(listJump(30, 60, { pageUp: true }, page)).toBe(20)
    expect(listJump(5, 60, { pageUp: true }, page)).toBe(0)
    expect(listJump(55, 60, { pageDown: true }, page)).toBe(59)
  })

  it('takes Home and End to the ends of the list', () => {
    expect(listJump(37, 60, { home: true }, page)).toBe(0)
    expect(listJump(3, 60, { end: true }, page)).toBe(59)
  })

  it('leaves the arrow keys alone, and an empty list with nothing to jump to', () => {
    expect(listJump(3, 60, { upArrow: true, downArrow: true }, page)).toBeNull()
    expect(listJump(0, 0, { pageDown: true, home: true }, page)).toBeNull()
  })
})

/** A screen with one ScrollingList and the jump keys bound, the way a real list screen is. */
function Harness({
  count,
  rows,
  chrome = 0,
}: {
  readonly count: number
  readonly rows: number | undefined
  readonly chrome?: number
}) {
  const items = Array.from({ length: count }, (_, index) => `row ${String(index)}`)
  const [index, setIndex] = useState(0)
  const indexRef = useRef(0)
  const page = viewportRows(rows, chrome)

  useInput((_input, key) => {
    const move = (next: number): void => {
      const clamped = Math.min(Math.max(next, 0), Math.max(items.length - 1, 0))
      indexRef.current = clamped
      setIndex(clamped)
    }
    if (key.upArrow) {
      move(indexRef.current - 1)
      return
    }
    if (key.downArrow) {
      move(indexRef.current + 1)
      return
    }
    const jumped = listJump(indexRef.current, items.length, key, page)
    if (jumped !== null) move(jumped)
  })

  return (
    <ScrollingList
      items={items}
      index={index}
      rows={rows}
      chrome={chrome}
      renderRow={(item, position, marker) => (
        <Text color={position === index ? 'cyan' : undefined}>{`${marker} ${item}`}</Text>
      )}
    />
  )
}

describe('ScrollingList', () => {
  it('draws a short list unchanged: every row, no markers', () => {
    const instance = render(<Harness count={3} rows={24} />)
    const frame = frameOf(instance)
    expect(frame).toContain('❯ row 0')
    expect(frame).toContain('  row 1')
    expect(frame).toContain('  row 2')
    expect(frame).not.toContain('more')
    instance.unmount()
  })

  it('keeps the cursor in the frame when it moves past the bottom and back past the top', async () => {
    // A 16-row terminal with six lines of chrome: ten rows fit, like the model picker's window.
    const instance = render(<Harness count={60} rows={16} chrome={6} />)
    await waitForFrame(instance, '❯ row 0')
    // The first frame is windowed: the rows past the tenth are out of sight and counted.
    expect(frameOf(instance)).toContain('↓ 50 more')

    for (let press = 0; press < 12; press += 1) {
      pressKey(instance, 'down')
    }
    await waitForFrame(instance, '❯ row 12')
    // The selected row is on screen with what is above and below it counted.
    expect(frameOf(instance)).toContain('↑ 7 more')
    for (let press = 0; press < 20; press += 1) {
      pressKey(instance, 'down')
    }
    await waitForFrame(instance, '❯ row 32')
    expect(frameOf(instance)).toContain('↑')
    expect(frameOf(instance)).toContain('more')

    // Back past the top: the cursor is drawn on row 0 with everything below it counted.
    pressKey(instance, 'home')
    await waitForFrame(instance, '❯ row 0')
    expect(frameOf(instance)).toContain('↓ 50 more')
    instance.unmount()
  })

  it('jumps a page at a time with PgDn/PgUp, and to the ends with Home/End', async () => {
    const instance = render(<Harness count={60} rows={16} chrome={6} />)
    await waitForFrame(instance, '❯ row 0')

    pressKey(instance, 'pageDown')
    await waitForFrame(instance, '❯ row 10')
    pressKey(instance, 'pageDown')
    await waitForFrame(instance, '❯ row 20')
    pressKey(instance, 'pageUp')
    await waitForFrame(instance, '❯ row 10')

    pressKey(instance, 'end')
    await waitForFrame(instance, '❯ row 59')
    expect(frameOf(instance)).toContain('↑ 50 more')
    pressKey(instance, 'home')
    await waitForFrame(instance, '❯ row 0')
    instance.unmount()
  })

  it('marks the selected row with a glyph, so it reads with colour off', async () => {
    const instance = render(<Harness count={4} rows={24} />)
    await waitForFrame(instance, '❯ row 0')
    const frame = frameOf(instance)
    // The marker is a character in the frame, not only a colour on it.
    expect(frame).toContain('❯ row 0')
    expect(frame).not.toContain('❯ row 1')
    instance.unmount()
  })

  it('shows fewer rows on a shorter terminal', async () => {
    const instance = render(<Harness count={40} rows={8} chrome={1} />)
    await waitForFrame(instance, '❯ row 0')
    const frame = frameOf(instance)
    // Seven rows fit; the eighth is out of sight and counted.
    expect(frame).toContain('  row 6')
    expect(frame).not.toContain('row 7')
    expect(frame).toContain('↓ 33 more')
    instance.unmount()
  })
})
