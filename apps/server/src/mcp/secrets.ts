import type { McpServerId, UserId } from '@openharness/protocol'
import type { SealedSecret, Vault } from '@openharness/vault'

/**
 * Sealing and opening a user's MCP secrets (epic #303, X10).
 *
 * The header map, the OAuth tokens and the registered OAuth client are sealed with
 * `@openharness/vault`, exactly as a provider credential is: a fresh data key per secret,
 * AES-256-GCM, and an associated-data string that binds the ciphertext to what it describes.
 * Nothing here logs, and nothing here ever returns a plaintext to a response — the sealed blob
 * is stored and only the code that makes a request opens it, for that request.
 *
 * The associated data is `mcp:{userId}|{serverId}|{purpose}`. It differs from a provider
 * credential's `userId|name` in two ways on purpose: the `mcp:` prefix keeps the two families
 * of sealed rows from ever decrypting under each other's associated data, and the server id —
 * not the name — is what a row is bound to, so renaming a server does not invalidate its
 * secrets. `purpose` keeps the three blobs of one server from being swapped for one another.
 */

/** Which of a server's secrets a blob holds. */
export type McpSecretPurpose = 'headers' | 'tokens' | 'oauth_client'

/** The associated data one sealed MCP secret is bound to. */
export function mcpSecretAad(
  userId: UserId,
  serverId: McpServerId,
  purpose: McpSecretPurpose,
): string {
  return `mcp:${userId}|${serverId}|${purpose}`
}

/** The identity a {@link McpSecretPurpose} is sealed for. */
export interface McpSecretBinding {
  readonly userId: UserId
  readonly serverId: McpServerId
  readonly purpose: McpSecretPurpose
}

/** Seal one secret for its binding. */
export function sealMcpSecret(
  vault: Vault,
  binding: McpSecretBinding,
  plaintext: string,
): Promise<SealedSecret> {
  return vault.seal(plaintext, mcpSecretAad(binding.userId, binding.serverId, binding.purpose))
}

/**
 * Open one sealed secret.
 *
 * A failure is a `VaultDecryptionError`/`VaultKeyError` from the vault — a tampered row, a
 * different binding or the wrong key provider — and never carries the plaintext.
 */
export function openMcpSecret(
  vault: Vault,
  binding: McpSecretBinding,
  sealed: SealedSecret,
): Promise<string> {
  return vault.open(sealed, mcpSecretAad(binding.userId, binding.serverId, binding.purpose))
}

/** Seal a JSON value: the caller's shape serialized, sealed, and parsed back on the way out. */
export async function sealMcpJson<T>(
  vault: Vault,
  binding: McpSecretBinding,
  value: T,
): Promise<SealedSecret> {
  return sealMcpSecret(vault, binding, JSON.stringify(value))
}

/**
 * Open a sealed JSON value.
 *
 * A blob that does not parse is treated as absent: a row only this server writes and reads is
 * never hand-edited, so an unparseable one means a bug or a tampered row, and the safe answer
 * is "no secret" — the server is then reconnected or re-checked rather than trusted.
 */
export async function openMcpJson<T>(
  vault: Vault,
  binding: McpSecretBinding,
  sealed: SealedSecret,
): Promise<T | null> {
  let text: string
  try {
    text = await openMcpSecret(vault, binding, sealed)
  } catch {
    return null
  }
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
