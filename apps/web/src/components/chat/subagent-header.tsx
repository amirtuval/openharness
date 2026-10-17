import type { Session } from '@openharness/protocol'
import { ChevronRight } from 'lucide-react'

import { sessionLabel } from '../../lib/format'
import type { ModelNameLookup } from '../../lib/models'
import { chatHash } from '../../lib/router'
import { Badge } from '../ui/badge'

/**
 * What a **child** session's chat says about where it came from (epic #340, S9; issue #346).
 *
 * Opening a card shows the child as a full chat — its own header, its own conversation and the
 * normal composer — and two things have to be said about it that a top-level chat has no
 * equivalent of:
 *
 * - **the breadcrumb** back up the tree: the root chat first, then each step down to this one,
 *   every step but the last a link. A reader three levels deep can always get back to where they
 *   started, and the trail is the same one `oh` walks (`sessionBreadcrumb`).
 * - **what "subagent" means here** (S1): the child's model cannot ask the user anything — it is
 *   offered no `ask_user` at all — while the reader may still message, interrupt and continue it.
 *   That is a surprising asymmetry, and a one-line banner is what makes it not surprising.
 *
 * It is drawn above the chat's own header, as a strip of its own, so the breadcrumb is chrome
 * about where the chat sits rather than part of the chat's title. The chain wraps and truncates
 * rather than overflowing: a deep tree at 390px is still one readable row of crumbs.
 */
export function SubagentHeader({
  chain,
  nameOf,
}: {
  /** The chain root first, ending with this session (from `useSessionBreadcrumb`). */
  chain: readonly Session[]
  /** The catalog lookup the crumbs label untitled sessions with (#91). */
  nameOf?: ModelNameLookup | undefined
}) {
  if (chain.length === 0) {
    return null
  }
  const current = chain.at(-1)
  return (
    <div data-slot="subagent-header" className="border-b bg-muted/20 px-4 py-2">
      <nav aria-label="Parent chats" className="flex flex-wrap items-center gap-1 text-2xs">
        {chain.map((step, index) => (
          <span key={step.id} className="flex min-w-0 items-center gap-1">
            {index === 0 ? null : (
              <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            )}
            {step.id === current?.id ? (
              // The last crumb is where the reader already is, so it is text rather than a link
              // (and `aria-current` says so to a screen reader).
              <span
                aria-current="page"
                data-slot="breadcrumb-current"
                className="max-w-[12rem] truncate font-medium"
              >
                {sessionLabel(step, nameOf)}
              </span>
            ) : (
              <a
                data-slot="breadcrumb-link"
                href={chatHash(step.id)}
                className="max-w-[12rem] truncate text-link hover:underline"
              >
                {sessionLabel(step, nameOf)}
              </a>
            )}
          </span>
        ))}
      </nav>
      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        <Badge variant="outline" className="text-2xs">
          subagent
        </Badge>
        <span data-slot="subagent-note">
          A subagent cannot ask you anything, but you can message and interrupt it.
        </span>
      </p>
    </div>
  )
}
