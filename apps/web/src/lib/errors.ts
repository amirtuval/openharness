/**
 * One line of text for anything that was thrown.
 *
 * Request failures in this app are shown inline rather than thrown at the user, so every
 * `catch` ends up here: an `ApiError` carries the server's message, an `AbortError` is not
 * worth reporting, and anything else gets its own words or a last-resort sentence.
 */
export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The request was cancelled.'
  }
  if (error instanceof Error) {
    return error.message === '' ? error.name : error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Something went wrong.'
}
