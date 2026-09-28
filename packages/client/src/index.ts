import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'

/** Placeholder export; the real client lands in the v1 chat epic. */
export const PACKAGE_NAME = '@openharness/client'

/**
 * Placeholder proof that the client → protocol edge resolves through built output
 * (`@openharness/protocol`'s `exports` → `dist/`), which is what fixes the build order.
 */
export const PROTOCOL_DEPENDENCY = PROTOCOL_PACKAGE_NAME
