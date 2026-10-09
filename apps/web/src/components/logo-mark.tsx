import { cn } from '../lib/utils'

/**
 * The openharness mark (issue #240): a ring left open at the upper right, with a dot in the
 * opening — the agent loop, open to the outside. The same drawing is the favicon
 * (`public/favicon.svg`), and the geometry below is the canonical copy of it: the test in
 * `src/icons.test.ts` reads both and fails if they drift.
 *
 * The two halves come from different tokens, and neither is a literal here. The ring is
 * `currentColor`, so it follows whatever ink the caller sets — {@link LogoMark} defaults to
 * `text-link`, which is the primary violet in Light and the lighter violet in Dim and Dark,
 * exactly the pair the favicon picks with its own `prefers-color-scheme` rule. The dot is
 * `fill-coral`, the highlight token. There is no hex in this file by design.
 *
 * The mark is decorative: it always sits next to the wordmark or a labelled link, so it is
 * hidden from assistive technology and the name comes from the text.
 */

/** The square the geometry is drawn in. */
export const LOGO_MARK_VIEW_BOX = '0 0 32 32'

/**
 * The ring: a stroked circle whose dash gap is the opening.
 *
 * The dash and the gap add up to the circumference (`2πr`), so the gap is one segment of about
 * 80° rather than an arc with ends to line up. Butt caps are the SVG default and are what the
 * mark is drawn with; the −6° turn puts the opening's centre at roughly 45°, the upper right.
 */
export const LOGO_MARK_RING = {
  cx: 16,
  cy: 16,
  r: 10.5,
  strokeWidth: 5,
  dashArray: '51.2 14.8',
  rotation: -6,
} as const

/** The dot, sitting in the ring's opening — on the stroke's own radius, at the same 45°. */
export const LOGO_MARK_DOT = { cx: 23.4, cy: 8.6, r: 3.6 } as const

/**
 * The mark, inline.
 *
 * Sized by `className` (`size-5` where the sidebar uses it) and coloured by the inherited ink,
 * so a caller can put it on any surface the tokens cover. A `className` that names a text
 * colour wins over the default `text-link`.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={LOGO_MARK_VIEW_BOX}
      className={cn('shrink-0 text-link', className)}
    >
      <circle
        cx={LOGO_MARK_RING.cx}
        cy={LOGO_MARK_RING.cy}
        r={LOGO_MARK_RING.r}
        fill="none"
        stroke="currentColor"
        strokeWidth={LOGO_MARK_RING.strokeWidth}
        strokeDasharray={LOGO_MARK_RING.dashArray}
        transform={`rotate(${LOGO_MARK_RING.rotation} ${LOGO_MARK_RING.cx} ${LOGO_MARK_RING.cy})`}
      />
      <circle
        cx={LOGO_MARK_DOT.cx}
        cy={LOGO_MARK_DOT.cy}
        r={LOGO_MARK_DOT.r}
        className="fill-coral"
      />
    </svg>
  )
}
