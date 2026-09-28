import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'

/** Placeholder export; the real hands land in the v1 chat epic. */
export const PACKAGE_NAME = '@openharness/hands'

/**
 * Placeholder proof that the hands → protocol edge resolves through built output
 * (`@openharness/protocol`'s `exports` → `dist/`), which is what fixes the build order.
 */
export const PROTOCOL_DEPENDENCY = PROTOCOL_PACKAGE_NAME
