/**
 * Strict base64 decoding, or `undefined` when the input is not base64 at all.
 *
 * `Buffer.from(value, 'base64')` is forgiving: it silently skips characters it does not
 * recognise and ignores leftover bits, so a corrupted field would decode to a shorter buffer
 * instead of failing. This guard rejects anything that is not the base64 alphabet with
 * padding at the end only; the caller then checks the length it expected, which catches
 * truncated or mispadded input as well.
 *
 * Unpadded base64 is accepted — a 32-byte key from `openssl rand -base64 32` is padded, but
 * truncating the padding does not change the key material, so there is no reason to refuse it.
 */
export function decodeBase64(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined
  return Buffer.from(value, 'base64')
}
