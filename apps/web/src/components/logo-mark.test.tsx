import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LOGO_MARK_DOT, LOGO_MARK_RING, LogoMark } from './logo-mark'

/**
 * The inline half of the mark (#240) — the other half is `public/favicon.svg`, and
 * `src/icons.test.ts` holds the two to the same geometry. What is checked here is what this
 * component draws and the rule the mark exists for on a themed page: no colour of its own.
 */
describe('LogoMark', () => {
  /** The mark's two circles, in draw order: the ring, then the dot. */
  function circles(container: HTMLElement): [SVGCircleElement, SVGCircleElement] {
    const found = [...container.querySelectorAll<SVGCircleElement>('svg > circle')]
    if (found[0] === undefined || found[1] === undefined) {
      throw new Error('the mark did not draw its two circles')
    }
    return [found[0], found[1]]
  }

  it('is decorative: one svg, hidden from assistive technology', () => {
    const { container } = render(<LogoMark />)

    const svg = container.querySelector<SVGSVGElement>('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelectorAll('svg')).toHaveLength(1)
  })

  it('draws the ring in the inherited ink and the dot in the coral token', () => {
    const { container } = render(<LogoMark />)
    const svg = container.querySelector<SVGSVGElement>('svg')
    const [ring, dot] = circles(container)

    // The ring follows the page: `currentColor` is whatever ink the caller sets, and the
    // default `text-link` is the pair — primary violet on Light, the lighter one on Dim/Dark.
    expect(svg).toHaveClass('text-link')
    expect(ring).toHaveAttribute('stroke', 'currentColor')
    expect(ring).toHaveAttribute('fill', 'none')
    expect(dot).toHaveClass('fill-coral')
    expect(dot).toHaveAttribute('cx', String(LOGO_MARK_DOT.cx))
  })

  it('carries no colour of its own', () => {
    const { container } = render(<LogoMark />)

    // A hex here would be a second palette beside the tokens in `index.css`, and would stop
    // following `data-theme`. The favicon is the one file that has to spell the values out.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}/iu)
  })

  it('keeps the canonical geometry on the two circles', () => {
    const { container } = render(<LogoMark />)
    const [ring, dot] = circles(container)

    expect(container.querySelector<SVGSVGElement>('svg')).toHaveAttribute('viewBox', '0 0 32 32')
    expect(ring).toHaveAttribute('r', String(LOGO_MARK_RING.r))
    expect(ring).toHaveAttribute('stroke-width', String(LOGO_MARK_RING.strokeWidth))
    expect(ring).toHaveAttribute('stroke-dasharray', LOGO_MARK_RING.dashArray)
    expect(ring).toHaveAttribute(
      'transform',
      `rotate(${LOGO_MARK_RING.rotation} ${LOGO_MARK_RING.cx} ${LOGO_MARK_RING.cy})`,
    )
    expect(dot).toHaveAttribute('cy', String(LOGO_MARK_DOT.cy))
    expect(dot).toHaveAttribute('r', String(LOGO_MARK_DOT.r))
  })

  it('is sized by the caller, and an ink the caller names wins over the default', () => {
    const { container } = render(<LogoMark className="size-5 text-primary" />)
    const svg = container.querySelector<SVGSVGElement>('svg')

    expect(svg).toHaveClass('size-5')
    expect(svg).toHaveClass('text-primary')
    expect(svg).not.toHaveClass('text-link')
  })
})
