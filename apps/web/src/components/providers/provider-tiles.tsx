import { CREDENTIAL_TARGETS, type CredentialTarget } from '@openharness/client'

import { ModelProviderIcon } from '../provider-icon'
import { FreeTierChip } from './free-tier-chip'

/**
 * The things a reader can connect, as tiles (epic #201, X5/X8; #245 A3a).
 *
 * One tile per entry in `@openharness/client`'s `CREDENTIAL_TARGETS` — the eleven providers,
 * then the named credential types (Azure OpenAI) — each with its mark, its name, and the
 * free-tier hint where it has one. A tile is a plain button: picking one is the whole
 * interaction, and what happens next is the caller's (the first-run screen and the dialog
 * differ only there).
 *
 * The whole list is offered, not only what a reader might already have a key for: the point of
 * the screen is "which of these do you have?", and hiding the one they hold would be the wrong
 * answer.
 */
export function ProviderTiles({
  onPick,
  disabled = false,
}: {
  /** A tile was picked. */
  onPick: (target: CredentialTarget) => void
  /** A save is in flight: picking another target would abandon it. */
  disabled?: boolean | undefined
}) {
  return (
    <ul className="grid list-none grid-cols-1 gap-2 sm:grid-cols-2">
      {CREDENTIAL_TARGETS.map((target) => (
        <li key={target.name}>
          <button
            type="button"
            data-slot="provider-tile"
            disabled={disabled}
            onClick={() => onPick(target)}
            className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <ModelProviderIcon provider={target.name} name={target.displayName} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm">{target.displayName}</span>
              {target.freeTier === undefined ? null : <FreeTierChip hint={target.freeTier} />}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
