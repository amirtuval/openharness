import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useStickToBottom } from './use-stick-to-bottom'

/**
 * The scroll behaviour, with jsdom's zero-height layout replaced by numbers.
 *
 * The hook only ever reads `scrollHeight`, `scrollTop` and `clientHeight`, so defining those
 * three on the element is enough to test the rule the browser would otherwise have to show:
 * follow the content while the reader is at the bottom, and let go the moment they are not.
 */
function Harness({ content }: { content: string }) {
  const { ref, onScroll, isStuck, scrollToLatest } = useStickToBottom(content)

  return (
    <div>
      <div ref={ref} onScroll={onScroll} data-testid="scroller">
        <p>{content}</p>
      </div>
      <span data-testid="stuck">{String(isStuck)}</span>
      <button type="button" onClick={scrollToLatest}>
        jump
      </button>
    </div>
  )
}

/** Give the scroller a geometry: 1000px of content in a 100px viewport. */
function scroller(element: HTMLElement): HTMLElement {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
  return element
}

describe('useStickToBottom', () => {
  it('follows new content while the reader is at the bottom', () => {
    const view = render(<Harness content="first" />)
    const element = scroller(screen.getByTestId('scroller'))

    view.rerender(<Harness content="first and a longer second chunk" />)

    expect(element.scrollTop).toBe(1000)
    expect(screen.getByTestId('stuck')).toHaveTextContent('true')
  })

  it('stops following once the reader scrolls up, and follows again on request', () => {
    const view = render(<Harness content="first" />)
    const element = scroller(screen.getByTestId('scroller'))

    // Scrolled up: 0 of 900 scrollable pixels used.
    element.scrollTop = 0
    fireEvent.scroll(element)
    expect(screen.getByTestId('stuck')).toHaveTextContent('false')

    // New content arrives and nothing moves.
    view.rerender(<Harness content="first, plus a chunk nobody asked to read" />)
    expect(element.scrollTop).toBe(0)
    expect(screen.getByTestId('stuck')).toHaveTextContent('false')

    // …until they ask to go back to the bottom.
    fireEvent.click(screen.getByRole('button', { name: 'jump' }))
    expect(element.scrollTop).toBe(1000)
    expect(screen.getByTestId('stuck')).toHaveTextContent('true')
  })

  it('stays stuck within the threshold', () => {
    render(<Harness content="first" />)
    const element = scroller(screen.getByTestId('scroller'))

    // 20px from the bottom, inside the 48px threshold.
    element.scrollTop = 880
    fireEvent.scroll(element)

    expect(screen.getByTestId('stuck')).toHaveTextContent('true')
  })
})
