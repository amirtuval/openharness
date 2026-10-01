/**
 * Scrubbing a provider credential out of text before it is stored or logged.
 *
 * A provider that rejects a key sometimes says so by quoting it: a 401 whose body reads
 * `Incorrect API key provided: sk-…`. The brain writes what a provider said into the session
 * log — the `session.error` and the span end that carry a failed request — and the credential
 * must not travel with the message (epic #65, A5: it is never in events, spans, error messages
 * or logs). Everything else about the message is kept, so the log still says what happened.
 *
 * The interesting cases are the trimmed ones: a provider may echo the key with a few leading
 * or trailing characters cut off, so the whole key, the key without its first
 * {@link TRIM_LENGTH} characters and the key without its last {@link TRIM_LENGTH} are all
 * replaced. The whole key goes first, so a trimmed pass can never leave the head or tail of a
 * longer match behind.
 */

/** What replaces a credential wherever it appears — visible, and unmistakably not a key. */
export const REDACTED_PLACEHOLDER = '[REDACTED]'

/** How many characters may be missing from either end of a key a provider echoed back. */
const TRIM_LENGTH = 4

/** The shortest run worth searching for, so a short key cannot shred an ordinary message. */
const MIN_SECRET_LENGTH = 8

/**
 * The text with every occurrence of `secret` — whole, minus its first {@link TRIM_LENGTH}
 * characters, or minus its last — replaced by {@link REDACTED_PLACEHOLDER}.
 *
 * A secret shorter than {@link MIN_SECRET_LENGTH} is not redacted at all: a four-character
 * fragment of it would match half of the English language, and a key that short is not one a
 * provider would echo. The match is exact and case-sensitive — API keys are — and every
 * occurrence is replaced, not just the first.
 *
 * @param text what the provider said, or anything else about to be stored or logged
 * @param secret the credential to scrub, when there is one
 */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
    return text
  }
  let redacted = text
  for (const variant of [secret, secret.slice(TRIM_LENGTH), secret.slice(0, -TRIM_LENGTH)]) {
    if (variant.length >= MIN_SECRET_LENGTH) {
      redacted = redacted.split(variant).join(REDACTED_PLACEHOLDER)
    }
  }
  return redacted
}
