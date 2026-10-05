# Releasing the CLI

The CLI (`apps/tui`, the `oh` command) ships to npm as the public package
[`openharness`](https://www.npmjs.com/package/openharness) — the one artefact in this repo that
leaves through npm rather than through GCP. It is released **by hand**, from
[`.github/workflows/publish-cli.yml`](../.github/workflows/publish-cli.yml) and nowhere else
([#156](https://github.com/amirtuval/openharness/issues/156), deployment epic
[#148](https://github.com/amirtuval/openharness/issues/148), decision D9). Server deploys never
publish the CLI and never move its dist-tags.

Publishing uses npm **trusted publishing**: the workflow takes a short-lived OIDC token from
GitHub, and npm exchanges it for its own ephemeral publish credential. There is no `NPM_TOKEN`
secret anywhere in the repository, and npm signs a **provenance** attestation of the build and
attaches it to the tarball ([npm docs](https://docs.npmjs.com/trusted-publishers)).

## Cutting a release

Actions → **publish-cli** → _Run workflow_, on `main`. Two inputs:

| input     | what it takes                                                                             |
| --------- | ----------------------------------------------------------------------------------------- |
| `version` | `patch`, `minor`, `major`, or an exact version such as `1.4.0`. Anything else is refused. |
| `dry_run` | Boolean, **default `true`**: publishes with `--dry-run` and stops before committing.      |

Then do it twice:

1. **A dry run first** — leave `dry_run` on. It builds, packs and installs the tarball and runs
   `npm publish --dry-run`, without publishing anything and without touching `main`.
2. **Then a real run** — set `dry_run` to **false**. This is what puts a version on npm.

What a real run does, in order:

1. checks out `main` with full history, Node 24, `yarn install --immutable`;
2. `npm version <input> --no-git-tag-version` in `apps/tui`, and reads the resulting version;
3. builds the CLI and its workspace dependencies (`yarn turbo run build --filter=openharness...`);
4. runs `yarn workspace openharness check:pack` — npm-packs the tarball, installs it into a clean
   directory outside the workspace, and runs the installed `oh --version`/`--help` (#152);
5. `npm publish --provenance --access public` from `apps/tui`. No `NPM_TOKEN`: npm authenticates
   with the OIDC token the job's `id-token: write` grants. No `--tag`: the publish lands on npm's
   default dist-tag, `latest`, and this workflow deliberately touches no other one;
6. **only after npm has accepted the publish**, commits the bump as `cli: v<version>` (author
   `github-actions[bot]`, adding `yarn.lock` if the bump moved it), pushes `main`, and pushes the
   tag `cli-v<version>`.

If that last push fails, the run fails and says so: the version **is already published**, and the
bump has to be committed and tagged by hand. Do **not** re-run the workflow — it would try to
publish the same version a second time. That is also why a run is never cancelled mid-flight
(`concurrency: publish-cli`, `cancel-in-progress: false`): a run stopped between the publish and
the push leaves exactly that state.

**What a dry run does not prove.** `npm publish --dry-run` performs no OIDC exchange and no
upload, so it cannot tell you that the trusted-publisher configuration below is right. It proves
the build, the pack and the version; the first real run is what proves the npm side.

### If `main` is protected

The workflow pushes the version bump straight to `main`. If `main` refuses direct pushes, that
push fails _after_ the publish has succeeded, and the bump has to be committed by hand. Either
let `github-actions[bot]` bypass the rule for this workflow, or accept the by-hand commit each
release. **Maintainer check** — this cannot be seen from the repository.

## One-time npm setup (the maintainer)

All of this is done once, by a human, with an npm account. The workflow cannot do any of it: a
trusted publisher is configured _on an existing package_, so the package has to exist before the
workflow can be allowed to publish it, and only the account that owns the name can create it.

1. **An npm account** with 2FA enabled — <https://www.npmjs.com/signup>.

2. **Claim the `openharness` name with a first, manual publish.** Trusted publishing cannot
   create a package: _"The package you're configuring must already exist on the npm registry"_
   ([`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust)). From a checkout of `main`:

   ```bash
   corepack enable
   yarn install --immutable
   yarn turbo run build --filter=openharness...
   yarn workspace openharness check:pack        # optional — proves the tarball before you publish it
   cd apps/tui
   npm login                                    # as the account that will own the package
   npm version 1.0.0 --no-git-tag-version       # pick the version this first release carries
   npm publish --access public
   ```

   Then commit that bump to `main` as `cli: v1.0.0` with the tag `cli-v1.0.0`, so the first
   workflow release bumps from the version npm already has rather than from the `0.0.0`
   placeholder.

3. **Configure the trusted publisher.** On the package page: **Settings → Trusted Publisher →
   GitHub Actions**, and fill in:

   | field                | value                                                                  |
   | -------------------- | ---------------------------------------------------------------------- |
   | Organization or user | `amirtuval`                                                            |
   | Repository           | `openharness`                                                          |
   | Workflow filename    | `publish-cli.yml` — the bare filename with its extension, never a path |
   | Environment name     | leave blank — this workflow uses no GitHub environment                 |
   | Allowed actions      | enable **`npm publish`** (direct publishing)                           |

   The "Workflow filename" is the file's name, not `.github/workflows/publish-cli.yml`, and it
   must exist in `.github/workflows/`. Every field is case-sensitive, and npm does not validate
   the configuration when you save it — a typo surfaces only as a failed publish.

   The last row is the one that is easy to miss: on npmjs.com today a new trusted publisher
   allows only **staged** publishing by default, and the `npm publish` this workflow runs is
   refused until direct publishing is enabled. The same configuration from the command line,
   with npm ≥ 11.15.0:

   ```bash
   npm trust github openharness \
     --file publish-cli.yml \
     --repo amirtuval/openharness \
     --allow-publish
   ```

   `--allow-publish` is the `npm publish` permission above; add `--allow-stage-publish` as well
   if you want staged publishes too.

4. **Lock it down (recommended).** In the package settings, require 2FA for writes and disallow
   tokens. The point of trusted publishing is that no long-lived credential exists; a token that
   still works is a way around it.

## Moving a dist-tag by hand

`npm publish` puts the new version on `latest`, and the workflow never passes `--tag` and never
touches another dist-tag. To move one by hand (as the package owner, with 2FA):

```bash
npm dist-tag add openharness@1.4.1 latest   # point `latest` at a published version
npm dist-tag ls openharness                 # what the tags point at now
```

## Verifying provenance

Every published tarball carries a signed attestation of the repository and commit it was built
from ([viewing package provenance](https://docs.npmjs.com/viewing-package-provenance)):

- on the npm package page, the version shows a **Provenance** badge linking to the attestation;
- from a project that depends on it, `npm audit signatures` verifies the registry signature and
  the provenance attestation of every installed package and reports each one as verified. To
  read the attestation bundles themselves, add `--json --include-attestations`.
