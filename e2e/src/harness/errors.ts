import { ApiError } from '@openharness/client'

/**
 * The {@link ApiError} a call threw.
 *
 * The tests are about refusals — 401 without a session, 404 for another user's resource, 422
 * for a key a provider rejects — and every one of them asserts the protocol's envelope rather
 * than a status string. This turns "it failed" into "it failed this way", and fails loudly
 * when the call unexpectedly succeeded.
 *
 * @throws Error when `work` resolved instead of throwing
 */
export async function errorOf(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work()
  } catch (error) {
    if (error instanceof ApiError) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to fail, but it resolved')
}
