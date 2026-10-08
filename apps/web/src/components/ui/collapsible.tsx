import { Collapsible as CollapsiblePrimitive } from 'radix-ui'
import * as React from 'react'

// Copied from the shadcn/ui registry (style `new-york-v4`), with the import paths rewritten for
// this app: no `@/` alias, see `AGENTS.md`.
//
// Radix wires the trigger's `aria-expanded`/`aria-controls` to the panel and takes the panel out
// of the DOM while it is closed — so a collapsed section holds no focusable field, which is the
// whole point of collapsing the server URL away (#209).

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return <CollapsiblePrimitive.Content data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger }
