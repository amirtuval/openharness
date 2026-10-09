import { Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '../../lib/utils'

// Copied from the shadcn/ui registry (style `new-york-v4`), with the import paths rewritten for
// this app: no `@/` alias, see `AGENTS.md`. The registry's `animate-in`/`animate-out` classes
// are dropped with it — this app has no animation plugin.
//
// `Tooltip` carries its own `Provider`, so a caller does not have to know that Radix wants one
// above the root: the delay is a property of the tooltip, not of the screen. It is a
// *description* — the accessible name of every control it is used with is still the control's
// own `aria-label`, which is what the tests and the QA pass read.

function Tooltip({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & { delayDuration?: number }) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipPrimitive.Provider>
  )
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-fit max-w-64 rounded-md bg-foreground px-2 py-1 text-xs text-balance text-background shadow-raised',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipTrigger }
