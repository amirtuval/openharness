import * as React from 'react'

import { cn } from '../../lib/utils'

// Close to the shadcn/ui registry's `skeleton` (style `new-york-v4`), with the import paths
// rewritten for this app and `bg-accent` swapped for `bg-muted`: accent is also the hover
// colour of every control in the shell, so a row of skeletons drawn in it reads as a row of
// hovered rows. `bg-muted` is the app's own "quiet surface" and is defined in all four themes.

/**
 * A placeholder for content that is still loading (epic #201, U10).
 *
 * One component for all of them — the chat list, the transcript's history, the model catalog —
 * so "still loading" looks the same wherever it happens, and a screen never has to say
 * "Loading…" in prose.
 *
 * Pass {@link SkeletonProps.label} when the shape alone does not say what is loading: the
 * placeholder then carries it as `role="status"` with screen-reader-only text, which is also
 * what a test reads. A group of skeletons that share one label should label only the first,
 * or the reader hears it once per bar.
 */
export function Skeleton({
  className,
  label,
  ...props
}: React.ComponentProps<'div'> & {
  /** What is loading, announced to a screen reader. */ label?: string
}) {
  return (
    <div
      data-slot="skeleton"
      role={label === undefined ? undefined : 'status'}
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    >
      {label === undefined ? null : <span className="sr-only">{label}</span>}
    </div>
  )
}
