import { VaultKeyError } from './errors'
import { type KeyEncryptionKeyProvider, type WrappedKeyMeta, unknownKeyError } from './keys'

/**
 * The Cloud KMS key provider (#150, decision D6): the master key never leaves KMS.
 *
 * Each secret's 32-byte data key is sent to Cloud KMS as an `Encrypt` call on one
 * `cryptoKeys/…` key and comes back as a KMS ciphertext, which is what a sealed secret stores
 * as its `wrappedKey`; `Decrypt` is the exact reverse. The client is authenticated with
 * Application Default Credentials — on GKE Autopilot that is Workload Identity, so no key
 * material is ever configured, mounted or shipped.
 *
 * Two properties are deliberate:
 *
 * - **The KMS client is loaded lazily**, on the first `wrap`/`unwrap` — never at import, and
 *   never by a deployment on `local`, which does not load `@google-cloud/kms` at all.
 * - **Rotation needs no data migration.** What is recorded beside a wrapped key is the
 *   *key* resource name, not a key version: KMS keeps old versions for `Decrypt`, and a new
 *   primary version is picked up by the next `Encrypt` with no code or data change.
 */

/** The key provider `gcp-kms`: {@link gcpKmsKeyProvider}. */
export const GCP_KMS_PROVIDER = 'gcp-kms'

/** 32 bytes: a data key this provider unwraps has to be one AES-256 key. */
const DATA_KEY_BYTES = 32

/**
 * The `KeyManagementServiceClient` shape this adapter uses, and the seam tests inject a fake
 * through ({@link GcpKmsKeyProviderOptions.createClient}).
 *
 * The real client's `encrypt`/`decrypt` answer a tuple of a protobuf response whose `bytes`
 * fields may arrive as a `Buffer`/`Uint8Array` or, over a JSON transport, as base64.
 */
export interface KmsClient {
  /** `Encrypt`: the plaintext data key in, the KMS ciphertext out. */
  encrypt(request: {
    readonly name: string
    readonly plaintext: Uint8Array
  }): Promise<readonly [{ readonly ciphertext?: Uint8Array | string | null }]>
  /** `Decrypt`: the KMS ciphertext in, the data key out. */
  decrypt(request: {
    readonly name: string
    readonly ciphertext: Uint8Array
  }): Promise<readonly [{ readonly plaintext?: Uint8Array | string | null }]>
}

/** What {@link gcpKmsKeyProvider} takes. */
export interface GcpKmsKeyProviderOptions {
  /**
   * The full Cloud KMS **key** resource name:
   * `projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>`. Not a key
   * version — see the module doc on rotation.
   */
  readonly key: string
  /**
   * How the KMS client is created, called once, lazily, on the first `wrap`/`unwrap`.
   * Defaults to importing `@google-cloud/kms` and building `KeyManagementServiceClient`;
   * tests inject a fake so nothing reaches a network.
   */
  readonly createClient?: () => Promise<KmsClient>
}

/**
 * A {@link KeyEncryptionKeyProvider} backed by one Cloud KMS key.
 *
 * ```ts
 * const provider = gcpKmsKeyProvider({ key: process.env.OPENHARNESS_KMS_KEY! })
 * const vault = createVault(provider)
 * ```
 *
 * Construction validates the resource name and nothing else: no client is built, no
 * credential is read, no request is made. Errors from KMS itself are wrapped in a
 * {@link VaultKeyError} whose message carries the key name and never any key material.
 *
 * @throws VaultKeyError when `key` is not a Cloud KMS key resource name — a key *version*, or
 *   anything that is not a resource name at all, is refused here rather than at the first
 *   secret
 */
export function gcpKmsKeyProvider(options: GcpKmsKeyProviderOptions): KeyEncryptionKeyProvider {
  const key = assertKmsKeyName(options.key)
  const createClient = options.createClient ?? defaultKmsClient

  // One memoized promise: two calls racing the first wrap share one client, and a client
  // that failed to build fails every call the same way rather than being rebuilt each time.
  let client: Promise<KmsClient> | undefined
  const kms = (): Promise<KmsClient> => (client ??= createClient())

  return {
    meta: { provider: GCP_KMS_PROVIDER, key },

    async wrap(dataKey: Uint8Array): Promise<Uint8Array> {
      let ciphertext: Uint8Array | string | null | undefined
      try {
        const service = await kms()
        const [response] = await service.encrypt({ name: key, plaintext: Buffer.from(dataKey) })
        ciphertext = response.ciphertext
      } catch (cause) {
        throw new VaultKeyError(`Cloud KMS could not encrypt a data key with ${key}`, { cause })
      }
      const bytes = kmsBytes(ciphertext)
      if (bytes === undefined || bytes.byteLength === 0) {
        throw new VaultKeyError(`Cloud KMS answered an encrypt call with no ciphertext for ${key}`)
      }
      return bytes
    },

    async unwrap(wrapped: Uint8Array, meta: WrappedKeyMeta): Promise<Uint8Array> {
      if (meta.provider !== GCP_KMS_PROVIDER || meta.key !== key) {
        // Checked before the client is built: a secret this key did not wrap is refused
        // without a KMS call, and with an error that names both keys.
        throw unknownKeyError(meta, GCP_KMS_PROVIDER, key)
      }
      let plaintext: Uint8Array | string | null | undefined
      try {
        const service = await kms()
        const [response] = await service.decrypt({ name: key, ciphertext: Buffer.from(wrapped) })
        plaintext = response.plaintext
      } catch (cause) {
        throw new VaultKeyError(`Cloud KMS could not decrypt a data key with ${key}`, { cause })
      }
      const bytes = kmsBytes(plaintext)
      if (bytes === undefined || bytes.byteLength !== DATA_KEY_BYTES) {
        throw new VaultKeyError(
          `Cloud KMS returned a ${bytes === undefined ? 'missing' : `${bytes.byteLength}-byte`} ` +
            `value for a data key; it must be ${DATA_KEY_BYTES} bytes`,
        )
      }
      return bytes
    },
  }
}

/**
 * The real client, loaded on first use.
 *
 * The dynamic import is the whole point of this function being separate: a deployment on
 * `local` importing this module never loads `@google-cloud/kms`, and so never pays for
 * google-gax, a credential lookup or its dependency tree.
 */
async function defaultKmsClient(): Promise<KmsClient> {
  const { KeyManagementServiceClient } = await import('@google-cloud/kms')
  // The generated client is this interface in every way this adapter uses (call, first
  // response element, protobuf `bytes` as `Uint8Array | string | null`); it just also
  // declares extra tuple members and request echo fields the adapter ignores.
  return new KeyManagementServiceClient() as unknown as KmsClient
}

/** A protobuf `bytes` field as bytes: a base64 string from a JSON transport, or bytes. */
function kmsBytes(value: Uint8Array | string | null | undefined): Uint8Array | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  return typeof value === 'string'
    ? new Uint8Array(Buffer.from(value, 'base64'))
    : new Uint8Array(value)
}

/**
 * The shape of a Cloud KMS **key**: `projects/…/locations/…/keyRings/…/cryptoKeys/…`.
 *
 * A key *version* (`…/cryptoKeys/<key>/cryptoKeyVersions/<n>`) is refused, on purpose: it
 * would pin every new seal to one version and turn a rotation into a data migration.
 */
const KMS_KEY_NAME = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/

/** The key name, trimmed, or a {@link VaultKeyError} naming the variable and the shape. */
function assertKmsKeyName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!KMS_KEY_NAME.test(name)) {
    throw new VaultKeyError(
      'OPENHARNESS_KMS_KEY must be a Cloud KMS key resource name — ' +
        'projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>, not a key ' +
        `version — got ${JSON.stringify(value)}`,
    )
  }
  return name
}
