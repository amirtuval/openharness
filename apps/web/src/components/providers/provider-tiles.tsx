import { PROVIDERS } from '@openharness/client'

import { ModelProviderIcon } from '../provider-icon'

/**
 * The providers, as tiles (epic #201, X5/X8).
 *
 * One tile per provider in `@openharness/client`'s list — the same metadata the CLI offers
 * (#210) — each with its mark, its name, and the free-tier hint where the provider has one. A
 * tile is a plain button: picking one is the whole interaction, and what happens next is the
 * caller's (the first-run screen and the dialog differ only there).
 *
 * The whole list is offered, not only the providers a reader might already have a key for: the
 * point of the screen is "which of these do you have?", and hiding the one they hold would be
 * the wrong answer.
 */
export function ProviderTiles({
  onPick,
  disabled = false,
}: {
  /** A tile was picked. */
  onPick: (provider: string) => void
  /** A save is in flight: picking another provider would abandon it. */
  disabled?: boolean | undefined
}) {
  return (
    <ul className="grid list-none grid-cols-1 gap-2 sm:grid-cols-2">
      {PROVIDERS.map((provider) => (
        <li key={provider.id}>
          <button
            type="button"
            data-slot="provider-tile"
            disabled={disabled}
            onClick={() => onPick(provider.id)}
            className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <ModelProviderIcon provider={provider.id} name={provider.name} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm">{provider.name}</span>
              {provider.freeTier === undefined ? null : (
                <span className="block truncate text-xs text-muted-foreground">
                  {provider.freeTier}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
