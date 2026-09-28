import { PACKAGE_NAME as HANDS_PACKAGE_NAME } from '@openharness/hands'
import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'
import { PACKAGE_NAME as SESSION_PACKAGE_NAME } from '@openharness/session'

/** Placeholder export; the real harness loop lands in the v1 chat epic. */
export const PACKAGE_NAME = '@openharness/brain'

/**
 * Placeholder proof that the brain → protocol / session / hands edges resolve through built
 * output. Those three packages must be built before this one.
 */
export const DEPENDENCIES = [
  PROTOCOL_PACKAGE_NAME,
  SESSION_PACKAGE_NAME,
  HANDS_PACKAGE_NAME,
] as const
