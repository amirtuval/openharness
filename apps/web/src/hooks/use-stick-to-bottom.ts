import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** How close to the bottom still counts as "following along", in pixels. */
const NEAR_BOTTOM_PX = 48

/** What a scrolled-to-the-bottom container gives its renderer. */
export interface StickToBottom {
  /** Attach to the scrolling element. */
  readonly ref: RefObject<HTMLDivElement | null>
  /** Attach to the same element's `onScroll`. */
  readonly onScroll: () => void
  /** Whether the view is following the latest content. */
  readonly isStuck: boolean
  /** Scroll to the bottom and start following again. */
  readonly scrollToLatest: () => void
}

/**
 * Keep a scroll container pinned to its bottom while content streams in — but only if the
 * user has not scrolled up.
 *
 * The whole rule is one boolean: the container is "stuck" while the reader is at (or very
 * near) the bottom; scrolling up unsticks it and it stays unstuck until they come back or
 * press the jump button. `dependency` is anything that changes when the content does — the
 * message count and the length of the streaming text, in this app — and the scroll happens in
 * a layout effect, so a new delta never paints at the old scroll position.
 *
 * Hand-written because the app needs exactly this and nothing else from a scroll library.
 */
export function useStickToBottom(dependency: string | number): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isStuck, setIsStuck] = useState(true)
  // The same value in a ref: the layout effect must not re-run when only `isStuck` changes.
  const stuckRef = useRef(true)

  const scrollToLatest = useCallback(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    stuckRef.current = true
    setIsStuck(true)
    // jsdom (the tests) has no `Element.scrollTo`; assigning `scrollTop` works everywhere.
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight })
    } else {
      element.scrollTop = element.scrollHeight
    }
  }, [])

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = distance <= NEAR_BOTTOM_PX
    if (next !== stuckRef.current) {
      stuckRef.current = next
      setIsStuck(next)
    }
  }, [])

  useLayoutEffect(() => {
    if (stuckRef.current) {
      scrollToLatest()
    }
    // `dependency` is the caller saying "the content changed"; the scroll is the reaction.
  }, [dependency, scrollToLatest])

  return { ref, onScroll, isStuck, scrollToLatest }
}
