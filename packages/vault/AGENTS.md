# @openharness/vault

Envelope encryption for user secrets (epic [#65](https://github.com/amirtuval/openharness/issues/65),
decision A5; issue [#57](https://github.com/amirtuval/openharness/issues/57)). The server seals
a user's provider credential before the session store writes it, and opens it for one model
request; the database never holds a usable key on its own.

The local path is pure: `node:crypto` only. Since
[#150](https://github.com/amirtuval/openharness/issues/150) (deployment epic #148, decision D6)
the master key can instead live in **Cloud KMS**, where a wrap is a KMS `Encrypt` call — and
`@google-cloud/kms` is imported dynamically, on the first use, so a `local` deployment never
loads it. No database, no logging, no `@openharness/*` dependency, and the only state is the
bounded in-memory cache of unwrapped data keys (see `createVault`'s options).

## Commands

Run from this folder (`packages/vault`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | watch mode                                                              |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

## The scheme

Every `seal(plaintext, aad)`:

1. draws a fresh random **32-byte data key** and a **12-byte nonce**;
2. encrypts the plaintext with **AES-256-GCM** under the data key, with `aad` (the caller's
   binding string — the server passes `userId|provider`) as associated data;
3. **wraps** (encrypts) the data key with the **master key** — from the server environment, or
   in Cloud KMS — through a `KeyEncryptionKeyProvider`;
4. returns `{ ciphertext, nonce, wrappedKey, kekVersion, keyProvider }` — the three secrets as
   base64 strings plus the names of the provider and the key that wrapped it, one database
   row.

`open(sealed, aad)` is the exact reverse, and it is where the data-key cache lives: an
unwrapped data key is kept for a few minutes (bounded and configurable, see
`VaultOptions`), so opening the same stored secret again — one model request after another —
does not ask KMS again. The data key is zeroed after use, in both directions, as far as Node
lets go of it; the cached copy is zeroed when it expires or is evicted, and every caller gets
its own copy.

The nonce is fresh per seal and the data key is fresh per secret, so two seals of the same
plaintext never produce the same bytes. A wrong `aad`, tampered bytes, a malformed field or a
`kekVersion` the provider does not know all end in a `VaultDecryptionError` — the same class
for all of them, so a caller cannot use the error to tell "wrong user" from "corrupted row".
A secret whose recorded **provider** is not the one this vault runs with is the one
exception, and deliberately so: it is a `VaultKeyError` naming both providers, thrown before
the master key is touched, because that is a deployment that has to be fixed, not a corrupt
row a caller could retry.

## Keys

Two providers ship here (#150, decision D6); the server picks between them with
`OPENHARNESS_KEY_PROVIDER`. Nothing in this package touches `process.env` — the server reads
the variables and constructs the provider.

- **`local`** (the default) — `envKeyProvider(base64Key)`: the master key is
  `OPENHARNESS_SECRETS_KEY`, 32 bytes, base64 (generate one with `openssl rand -base64 32`).
  The value is rejected at construction — at server boot, in practice — when it is missing,
  is not base64 or does not decode to exactly 32 bytes. The error names the variable and, at
  most, how many bytes the value decoded to; it never echoes the key.
- **`gcp-kms`** — `gcpKmsKeyProvider({ key })`: the master key never leaves **Cloud KMS**.
  Each wrap is an `Encrypt` call on the `OPENHARNESS_KMS_KEY` key
  (`projects/…/cryptoKeys/…`) and each unwrap a `Decrypt`, authenticated with Application
  Default Credentials — Workload Identity on GKE, so nothing is mounted or configured. The
  client is built on the **first wrap or unwrap**, never at construction or import: a `local`
  deployment never loads `@google-cloud/kms`. The recorded key name deliberately has no
  `/cryptoKeyVersions/…` suffix — rotating the KMS key version needs no data migration,
  because KMS keeps old versions around for `Decrypt`, and the next `Encrypt` picks up the
  new primary version.

Every sealed secret records which provider wrapped it (`keyProvider`) and the provider's name
for the key (`kekVersion`). `open` refuses a secret under a provider the vault is not, with a
`VaultKeyError` naming both — so a `local` row cannot be opened by a `gcp-kms` server, and
the reverse, and a deployment that switches `OPENHARNESS_KEY_PROVIDER` gets that error (not
"this row is corrupt") for every credential it holds. **Rekeying means re-saving those
credentials**; there is no cross-provider migration path, on purpose. A `SealedSecret`
without `keyProvider` predates the field, when `local` was the only provider: absent means
`local`.

## Threat model

- **A database dump without the master key reveals nothing.** A stored row holds the
  ciphertext, the nonce, the wrapped data key and the names of the provider and key that
  wrapped it. Without `OPENHARNESS_SECRETS_KEY` — or, under `gcp-kms`, without a KMS identity
  that may use the key — none of those can produce a plaintext: the data key is itself
  encrypted under the master key.
- **The master key lives in the server environment, or never leaves KMS.** It is never
  written to the database, never committed, never logged and never echoed in an error message.
  Nothing in this package logs anything at all, and the tests assert that no message,
  `String()`, `JSON.stringify()` or `util.inspect()` of the vault, either provider or an error
  contains the plaintext or the master key — and that a JSON dump of a sealed secret carries
  neither it nor the plaintext base64-encoded.
- **Unwrapped data keys live in memory for a few minutes.** `createVault` caches them (TTL and
  size bounded, `0` disables) so a model request does not always make a KMS round trip.
  Nothing else is cached — never a plaintext, never the master key — cached keys are zeroed on
  expiry and eviction, and every caller is handed a copy.
- **The `aad` binds the ciphertext to what it describes.** The server passes `userId|provider`
  as the associated data, so a sealed secret copied to another user's account — or to another
  provider's record — fails to open even with the master key in hand.
- **Key rotation is the provider's business now.** `kekVersion` records which key wrapped a
  secret and `KeyEncryptionKeyProvider.unwrap` receives it back, which is the seam rotation
  uses: the local provider knows exactly one key (`v1`) and refuses anything else with a
  `VaultDecryptionError`; KMS rotates versions under one name, invisibly here.
- **The provider is the seam.** `KeyEncryptionKeyProvider` is the only place the master key is
  used: `local` and `gcp-kms` are two implementations of one interface, and the vault does not
  know which it holds beyond the `meta` it records.

## Public API

| `@openharness/vault`                                        | what it is                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `KeyEncryptionKeyProvider`                                  | interface: `{ meta, wrap(dataKey), unwrap(wrapped, meta) }`                                    |
| `WrappedKeyMeta`                                            | `{ provider, key }`: which provider and which of its keys wrapped a data key — never material  |
| `LOCAL_KEY_PROVIDER`, `envKeyProvider(base64Key)`           | the `OPENHARNESS_SECRETS_KEY` provider: AES-256-GCM wrapping, meta `{ local, v1 }`             |
| `GCP_KMS_PROVIDER`, `gcpKmsKeyProvider(options)`            | the Cloud KMS provider; `KmsClient` and `createClient` are the seam a test injects a fake with |
| `GcpKmsKeyProviderOptions`, `KmsClient`                     | its options (`key`, `createClient`) and the client subset the adapter uses                     |
| `createVault(kek, options?)`                                | → `Vault`: `seal(plaintext, aad)` / `open(sealed, aad)`, with the data-key cache               |
| `VaultOptions`                                              | `{ keyCacheTtlMs?, keyCacheMaxEntries?, now? }` — the cache's TTL, size limit and clock        |
| `DEFAULT_KEY_CACHE_TTL_MS`, `DEFAULT_KEY_CACHE_MAX_ENTRIES` | `300000` (five minutes), `1024`                                                                |
| `SealedSecret`                                              | `{ ciphertext, nonce, wrappedKey, kekVersion, keyProvider? }`, JSON-ready, no key material     |
| `Vault`, `VaultError`                                       | the vault interface; the base error class                                                      |
| `VaultKeyError`                                             | an unusable master key, a provider mismatch, or an unknown key name                            |
| `VaultDecryptionError`                                      | `open` failed: wrong `aad`, tampered bytes, malformed field or unknown key                     |

## Allowed `@openharness/*` dependencies

None (see the table in `docs/architecture.md`): this package depends on no other
`@openharness/*` package, and `@openharness/server` may depend on it. `@openharness/config`
is additionally allowed as a **devDependency**. Its one external runtime dependency,
`@google-cloud/kms` (#150), is imported dynamically on the first Cloud KMS call and has to
stay a `dependencies` entry so `docker/Dockerfile`'s `yarn workspaces focus --production
@openharness/server` puts it in the image.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Testing

`src/**/*.test.ts` with Vitest (node environment): a round trip; a wrong `aad`; tampered
ciphertext, nonce and wrapped key; distinct seals; unknown key versions; invalid master keys;
legacy rows that predate `keyProvider` (absent means `local`); the provider mismatch both
ways; the data-key cache (a hit skips the provider, the TTL expires, the size limit evicts the
oldest entry, `0` disables); the Cloud KMS adapter against a fake client behind the same
interface (request shapes, the client built lazily and once, a refusing client wrapped into a
clean error); and a leak suite asserting that no string reachable from the vault, either
provider or any error contains the plaintext or the master key. One suite is opt-in: with
`OPENHARNESS_TEST_KMS_KEY` set to a real `cryptoKeys/…` name and Application Default
Credentials available, `kms.test.ts` runs a wrap, an unwrap and a vault round trip against
Cloud KMS itself; CI has no project, so it skips.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/vault/docs/`.
