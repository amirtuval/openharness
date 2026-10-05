# Workload Identity setup

GitHub Actions reaches GCP only through Workload Identity Federation — no service-account
keys (epic [#148](https://github.com/amirtuval/openharness/issues/148), decision D3). Actions
cannot create its own Workload Identity, so the maintainer runs
[`workload-identity.sh`](./workload-identity.sh) once per project, with their own gcloud
credentials. It is the one piece of the deployment that is not Terraform; Artifact Registry,
GKE, Cloud SQL, secrets and everything else come later, as Terraform.

The script is idempotent: everything it owns is declared in lists at the top of the script,
and a re-run converges the project to them — see [Re-running](#re-running-convergent-additive-or-pruning).

## Prerequisites

- `gcloud` installed and logged in (`gcloud auth login`), with **Owner** on the project.
- `gh` installed and logged in (`gh auth login`), with **admin** on the repository —
  creating environments and variables asks for it.
- `jq` — `--prune` reads the current IAM policies with `gcloud ... get-iam-policy
--format=json` and parses them with it. A run without `--prune` does not need it.
- The project exists and has **billing linked**. Both projects (`openharness-dev` for
  staging, `openharness` for production) are created by hand; the script creates nothing
  itself.
- A recent gcloud, for the `gcloud billing` and `gcloud storage` command groups.

## Run

For staging (project `openharness-dev`):

```bash
./.github/setup/workload-identity.sh staging --dry-run   # print every command, run nothing
./.github/setup/workload-identity.sh staging
```

Then for production (project `openharness`):

```bash
./.github/setup/workload-identity.sh production
```

Run staging before production — that is the epic's order (D7).

| Flag                           | Effect                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo OWNER/REPO`            | this repository (default `amirtuval/openharness`)                                                                                                              |
| `--deploy-roles=owner\|narrow` | which deploy project-roles list the run applies — the default `roles/owner`, or the narrower alternative (see [Role choices and risk](#role-choices-and-risk)) |
| `--prune`                      | additionally remove the managed accounts' bindings the lists no longer declare (see [Re-running](#re-running-convergent-additive-or-pruning))                  |
| `--dry-run`                    | print every gcloud and gh command, execute nothing                                                                                                             |

`--dry-run` needs no gcloud, gh or login at all; the project number, which only gcloud can
resolve, appears as `<project-number>` in its output. Because it executes nothing, it also
cannot list the exact bindings `--prune` would remove — reading those needs the live
policies — so it prints the prune rules instead.

## The lists: edit, then re-run

What the script owns is declared in bash arrays at the top of `workload-identity.sh` —
adding an API or a permission is a one-line change, and nothing else in the script needs
touching:

| List                          | What it holds                                                 |
| ----------------------------- | ------------------------------------------------------------- |
| `APIS`                        | the APIs to enable                                            |
| `DEPLOY_PROJECT_ROLES`        | project roles for `deploy@` — `roles/owner` by default        |
| `DEPLOY_PROJECT_ROLES_NARROW` | the narrower alternative, chosen with `--deploy-roles=narrow` |
| `PLAN_PROJECT_ROLES`          | project roles for `tf-plan@`                                     |
| `PLAN_STATE_BUCKET_ROLES`     | `tf-plan@`'s roles on the state bucket                           |

To need a new API, role or service: add a line, re-run the script. The run converges —
it creates what is missing and updates what exists (pool, provider, service accounts). A
role that is _removed_ from a list stays granted until a run with `--prune`.

The provider's claim mapping and attribute condition are the two exceptions: they are
computed from `--repo`, with `WIF_ATTRIBUTE_MAPPING` and `WIF_ATTRIBUTE_CONDITION` as the
override seam (the test drives them; a one-off migration can too).

## What it creates

Per project, in `us-central1` except where noted:

| What               | Detail                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| APIs               | `iam`, `iamcredentials`, `sts`, `cloudresourcemanager`, `serviceusage`, `storage` — Terraform enables the rest (D4)                                                                                                                                    |
| Workload Identity  | pool `github` (global)                                                                                                                                                                                                                                 |
| OIDC provider      | `github`, issuer `https://token.actions.githubusercontent.com`, attribute condition `assertion.repository == 'amirtuval/openharness'`; the mapping exposes `attribute.repository`, `attribute.environment`, `attribute.ref` and `attribute.event_name` |
| Service account    | `deploy@<project>` — Terraform apply, role `roles/owner` on the project                                                                                                                                                                                |
| Service account    | `tf-plan@<project>` — `terraform plan` on PRs, `roles/viewer` + `roles/iam.securityReviewer`, and `roles/storage.objectAdmin` on the state bucket only                                                                                                    |
| Terraform state    | bucket `gs://<project>-tfstate` with versioning, uniform bucket-level access and public access prevention                                                                                                                                              |
| GitHub environment | `staging` or `production`, with the variables below                                                                                                                                                                                                    |

On a re-run, the pool's, the provider's and the two accounts' display names and
descriptions are applied to the existing resources (`workload-identity-pools update`,
`providers update-oidc`, `service-accounts update`) — they converge instead of staying at
whatever they were created with.

The pool's attribute condition admits only this repository's runs into the pool; a token from
any other repository fails its exchange. Impersonation bindings (`roles/iam.workloadIdentityUser`):

| Account  | May only be impersonated by                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy` | `principalSet://…/workloadIdentityPools/github/attribute.environment/<staging\|production>` — jobs running in that exact GitHub environment |
| `plan`   | `principalSet://…/workloadIdentityPools/github/attribute.event_name/pull_request` — this repository's PR runs                               |

The `environment` claim exists only when a workflow job declares a GitHub environment, so
production's deploy account is not reachable from any other environment, branch or PR — and
is the reason a deploying job must carry `environment: production` to impersonate it.

## Variables it sets

Each run sets the same six variables in the matching GitHub environment, and the same six at
repository level with a `_STAGING` / `_PRODUCTION` suffix:

| Variable             | Value                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| `GCP_PROJECT_ID`     | `openharness-dev` / `openharness`                                                  |
| `GCP_PROJECT_NUMBER` | the project number                                                                 |
| `GCP_WIF_PROVIDER`   | `projects/<number>/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA`      | `deploy@<project>.iam.gserviceaccount.com`                                         |
| `GCP_PLAN_SA`        | `tf-plan@<project>.iam.gserviceaccount.com`                                           |
| `TF_STATE_BUCKET`    | `<project>-tfstate`                                                                |

Variables only — the script creates no secrets anywhere (D5: the only Actions secret stays
`OPENAI_API_KEY`, for the provider smoke test).

The environment-scoped copies are what the deploy workflows (#155) read: they run inside the
environment, so its protection rules apply. The `_STAGING` / `_PRODUCTION` copies are for
`terraform-pr.yml`, which runs outside any environment and plans both projects.

## Role choices and risk

**`deploy` gets `roles/owner`.** Terraform (wave 2) manages the whole project — IAM, service
accounts, GKE, Cloud SQL, Secret Manager, KMS, DNS, Artifact Registry — and Owner is the one
role that keeps up with that without a list to maintain. Its blast radius is one project, and
only a job running in this repository's matching GitHub environment can impersonate it. The
narrower admin roles are `DEPLOY_PROJECT_ROLES_NARROW` in the script; `--deploy-roles=narrow`
applies them instead (with `--prune`, that also drops Owner). Two caveats: that list has to
stay in sync as Terraform grows, and it cannot cover the billing budgets (D4) — they live on
the billing account, so whichever identity creates them needs a grant there, which
project-level Owner does not give either.

**`plan` gets `roles/viewer`, `roles/iam.securityReviewer` and `roles/storage.objectAdmin` on
the state bucket only.** Viewer reads the project; securityReviewer adds read-only IAM policy
reads, which a plan that refreshes IAM resources needs and Viewer alone does not give.
objectAdmin on the one bucket is what the Terraform lock needs (create/delete of `.tflock`).

**The plan binding's risk.** `attribute.event_name/pull_request` matches any `pull_request`
run of this repository. That includes a PR from a fork, whose workflow can request an OIDC
token issued in this repository's name — so a fork PR can impersonate `plan`. The account is
read-only apart from the state bucket, where it can read state (which holds the generated
secrets, D5) and write or delete state objects; bucket versioning keeps every earlier
version, so tampering is recoverable rather than lost. If that exposure is not acceptable,
`terraform-pr.yml` (#155) can gate plans to same-repository PRs. The alternative — a
repository-scoped `attribute.repository/amirtuval/openharness` binding — would accept every
event of this repository, pushes included, so `event_name` is the tighter of the two.

**Renames.** The attribute condition pins `assertion.repository == 'amirtuval/openharness'`.
If the repository is renamed or transferred, re-run the script with `--repo OWNER/REPO`:
the provider exists already, so the run applies the new condition and mapping through
`providers update-oidc`. (Before #161 the provider was create-only; the README used to ask
for a manual `update-oidc` or a delete-and-recreate.)

## Re-running: convergent, additive, or pruning

Safe, by design. A re-run converges the project to the lists at the top of the script:

- it creates what is missing;
- it **updates** what exists: the pool, the OIDC provider (the declared mapping, condition
  and issuer are re-applied with `update-oidc` on every run) and the two service accounts'
  display names and descriptions;
- it re-applies the settings it owns as idempotent updates: the APIs, the bucket settings,
  the IAM bindings and the GitHub variables.

The default run is **additive**: a role removed from a list stays granted. `--prune`
removes the rest, printing each removal:

- project roles of `deploy@` and `tf-plan@` that are not in the active lists;
- their bindings on the state bucket that are not declared — `deploy@` is declared none
  there, so any of its bucket bindings goes;
- `roles/iam.workloadIdentityUser` members on the two accounts other than the declared
  principalSet.

Only bindings whose member is one of those two accounts are ever considered: another
member's bindings are never touched. Removals use the CLI's `--all`, so a stale role goes
whether its binding is conditional or not. And a run — pruned or not — never touches a
resource it did not create:

- an existing GitHub environment is not re-PUT, so its **protection rules are never
  modified**;
- another member's IAM bindings are never removed, by a normal run or by `--prune`.

## Test

`.github/setup/test/run-tests.sh` proves all of the above — converge-on-re-run, the
provider update, `--prune` selectivity, dry-run purity — without gcloud, gh, a login or
network:

```bash
./.github/setup/test/run-tests.sh
```

It runs the real script against stateful fakes (`test/bin/gcloud.sh`, `test/bin/gh.sh`)
that keep what they are told to create in a temp directory, fail on creating what already
exists the way the real CLIs do, and log every call. bash and `jq` are all it needs. CI
runs it, plus `shellcheck` on every script in this folder, in
`.github/workflows/setup-script.yml` whenever `.github/setup/**` changes.

## Undo

Per environment — staging shown; the same with `openharness` and `production` for production:

```bash
# GitHub
for v in GCP_PROJECT_ID GCP_PROJECT_NUMBER GCP_WIF_PROVIDER GCP_DEPLOY_SA GCP_PLAN_SA TF_STATE_BUCKET; do
  gh variable delete "$v" --repo amirtuval/openharness --env staging
  gh variable delete "${v}_STAGING" --repo amirtuval/openharness
done
gh api --method DELETE repos/amirtuval/openharness/environments/staging   # only if no workflow uses it

# GCP
gcloud projects remove-iam-policy-binding openharness-dev \
  --member="serviceAccount:deploy@openharness-dev.iam.gserviceaccount.com" --role=roles/owner
gcloud projects remove-iam-policy-binding openharness-dev \
  --member="serviceAccount:tf-plan@openharness-dev.iam.gserviceaccount.com" --role=roles/viewer
gcloud projects remove-iam-policy-binding openharness-dev \
  --member="serviceAccount:tf-plan@openharness-dev.iam.gserviceaccount.com" --role=roles/iam.securityReviewer
gcloud iam service-accounts delete deploy@openharness-dev.iam.gserviceaccount.com
gcloud iam service-accounts delete tf-plan@openharness-dev.iam.gserviceaccount.com
gcloud iam workload-identity-pools providers delete github \
  --workload-identity-pool=github --location=global --project=openharness-dev
gcloud iam workload-identity-pools delete github --location=global --project=openharness-dev
gcloud storage rm --recursive gs://openharness-dev-tfstate/
```

The workload-identity bindings sit on the service accounts and go with them. The bucket
command is teardown only — after the first apply it holds the Terraform state. The APIs stay
enabled; disabling them is not part of this undo.
