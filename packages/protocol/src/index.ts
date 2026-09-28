import { z } from 'zod'

/** Placeholder export; the real protocol lands in the v1 chat epic. */
export const PACKAGE_NAME = '@openharness/protocol'

/**
 * Placeholder schema — not a real protocol type, and not a proposal for one. It exists to
 * prove that `zod` is wired up and that the build emits usable `.d.ts` files.
 */
export const PlaceholderSchema = z.object({ placeholder: z.literal(true) })

export type Placeholder = z.infer<typeof PlaceholderSchema>
