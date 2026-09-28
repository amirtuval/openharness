import { PROTOCOL_DEPENDENCY } from '../index'

/** Subpath export `@openharness/session/testing`: in-memory session helpers (placeholder). */
export const TESTING_PACKAGE_NAME = '@openharness/session/testing'

export const emptySession = { protocol: PROTOCOL_DEPENDENCY, events: [] as const } as const
