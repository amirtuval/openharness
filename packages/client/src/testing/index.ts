import { PROTOCOL_DEPENDENCY } from '../index'

/** Subpath export `@openharness/client/testing`: fakes for dependents (placeholder). */
export const TESTING_PACKAGE_NAME = '@openharness/client/testing'

export const fakeClientConfig = { protocol: PROTOCOL_DEPENDENCY, connected: false } as const
