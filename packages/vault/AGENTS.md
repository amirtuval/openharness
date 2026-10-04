# @openharness/vault

Envelope encryption for user secrets (epic [#65](https://github.com/amirtuval/openharness/issues/65),
decision A5; issue [#57](https://github.com/amirtuval/openharness/issues/57)). The server seals
a user's provider credential before the session store writes it, and opens it for one model
request; the database never holds a usable key on its own.

The package is pure: `node:crypto` only. No database, no network, no state, no logging, and no
`@openharness/*` dependency.

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
3. **wraps** (encrypts) the data key with the **master key** from the server environment,
   through a `KeyEncryptionKeyProvider`;
4. returns `{ ciphertext, nonce, wrappedKey, kekVersion }` — the three secrets as base64
   strings plus the wrapping key's version, one database row.

`open(sealed, aad)` is the exact reverse. The data key is zeroed after use, in both
directions, as far as Node lets go of it.

The nonce is fresh per seal and the data key is fresh per secret, so two seals of the same
plaintext never produce the same bytes. A wrong `aad`, tampered bytes, a malformed field or a
`kekVersion` the provider does not know all end in a `VaultDecryptionError` — the same class
for all of them, so a caller cannot use the error to tell "wrong user" from "corrupted row".

## Keys

The master key is `OPENHARNESS_SECRETS_KEY`: 32 bytes, base64. Generate one with:

```bash
openssl rand -base64 32
```

The server reads the variable from its environment and passes its value to
`envKeyProvider(base64Key)` (issue #61) — nothing in this package touches `process.env`. The
value is rejected at construction — at server boot, in practice — when it is missing, is not
base64 or does not decode to exactly 32 bytes. The error names the variable and, at most, how
many bytes the value decoded to; it never echoes the key.

## Threat model

- **A database dump without the server environment reveals nothing.** A stored row holds the
  ciphertext, the nonce, the wrapped data key and the key version. Without
  `OPENHARNESS_SECRETS_KEY` none of those can produce a plaintext: the data key is itself
  encrypted under the master key.
- **The master key lives only in the server environment.** It is never written to the
  database, never committed, never logged and never echoed in an error message. Nothing in
  this package logs anything at all, and the tests assert that no message, `String()`,
  `JSON.stringify()` or `util.inspect()` of the vault, the provider or an error contains the
  plaintext or the master key — and that a JSON dump of a sealed secret carries neither it
  nor the plaintext base64-encoded.
- **The `aad` binds the ciphertext to what it describes.** The server passes `userId|provider`
  as the associated data, so a sealed secret copied to another user's account — or to another
  provider's record — fails to open even with the master key in hand.
- **Key rotation is a later feature.** `kekVersion` records which master key wrapped a secret,
  and `KeyEncryptionKeyProvider.unwrap` receives it back, which is the seam rotation will use.
  Today only one version exists and anything else is a `VaultDecryptionError`.
- **A KMS can replace the environment key later.** `KeyEncryptionKeyProvider` is the only
  place the master key is used; a provider that calls KMS Encrypt/Decrypt (with a KMS key id
  as its `version`) implements the interface without any change to the vault.

## Public API

| `@openharness/vault`        | what it is                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `KeyEncryptionKeyProvider`  | interface: `{ version, wrap(dataKey), unwrap(wrapped, version) }`                     |
| `envKeyProvider(base64Key)` | the `OPENHARNESS_SECRETS_KEY` provider: AES-256-GCM wrapping, version `'v1'`          |
| `createVault(kek)`          | → `Vault`: `seal(plaintext, aad)` / `open(sealed, aad)`                               |
| `SealedSecret`              | `{ ciphertext, nonce, wrappedKey, kekVersion }`, the three secrets base64, JSON-ready |
| `Vault`, `VaultError`       | the vault interface; the base error class                                             |
| `VaultKeyError`             | an unusable master key or an unknown key version                                      |
| `VaultDecryptionError`      | `open` failed: wrong `aad`, tampered bytes, malformed field or unknown version        |

## Allowed `@openharness/*` dependencies

None (see the table in `docs/architecture.md`): this package depends on nothing, and
`@openharness/server` may depend on it. `@openharness/config` is additionally allowed as a
**devDependency**.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Testing

`src/**/*.test.ts` with Vitest (node environment): a round trip; a wrong `aad`; tampered
ciphertext, nonce and wrapped key; distinct seals; unknown key versions; invalid master keys;
and a leak suite asserting that no string reachable from the vault, the provider or any error
contains the plaintext or the master key.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/vault/docs/`.
