import { cn } from '../../lib/utils'

/**
 * A provider's free-tier hint, as a chip (epic #201, X8; U12, #227).
 *
 * The hint is the provider's own sentence — `Free tier in Google AI Studio`, `Free tier
 * available` — carried by `@openharness/client`'s metadata, so this component is only its
 * *look*: the wording belongs to the provider and the palette belongs to the app (the chip is
 * coral, the one thing on those screens that is good news). It is drawn in two places, the
 * first-run tiles and the key form, and having one component is what keeps them the same chip.
 */
export function FreeTierChip({
  hint,
  className,
}: {
  /** The provider's own sentence, from `@openharness/client`'s `PROVIDERS`. */
  hint: string
  className?: string | undefined
}) {
  return (
    <span
      data-slot="free-tier"
      className={cn(
        // The tint is the mark coral and the ink the tuned one, so the chip clears AA on all
        // three themes (5.1:1 on Light's own tint, 5.7:1 on Dim's, 5.9:1 on Dark's).
        'inline-block max-w-full truncate rounded-full bg-coral/15 px-1.5 py-px text-xs text-coral-ink',
        className,
      )}
    >
      {hint}
    </span>
  )
}
