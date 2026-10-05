# Workload Identity setup

GitHub Actions reaches GCP only through Workload Identity Federation — no service-account
keys (epic [#148](https://github.com/amirtuval/openharness/issues/148), decision D3). Actions
cannot create its own Workload Identity, so the maintainer runs
[`workload-identity.sh`](./workload-identity.sh) once per project, with their own gcloud
credentials. It is the one piece of the deployment that is not Terraform; Artifact Registry,
GKE, Cloud SQL, secrets and everything else come later, as Terraform.

## Prerequisites

- `gcloud` installed and logged in (`gcloud auth login`), with **Owner** on the project.
- `gh` installed and logged in (`gh auth login`), with **admin** on the repository —
  creating environments and variables asks for it.
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

Run staging before production — that is the epic's order (D7). `--repo OWNER/REPO` overrides
the default `amirtuval/openharness`. `--dry-run` needs no gcloud, gh or login at all; the
project number, which only gcloud can resolve, appears as `<project-number>` in its output.

## What it creates

Per project, in `us-central1` except where noted:

| What               | Detail                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| APIs               | `iam`, `iamcredentials`, `sts`, `cloudresourcemanager`, `serviceusage`, `storage` — Terraform enables the rest (D4)                                                                                                                                    |
| Workload Identity  | pool `github` (global)                                                                                                                                                                                                                                 |
| OIDC provider      | `github`, issuer `https://token.actions.githubusercontent.com`, attribute condition `assertion.repository == 'amirtuval/openharness'`; the mapping exposes `attribute.repository`, `attribute.environment`, `attribute.ref` and `attribute.event_name` |
| Service account    | `deploy@<project>` — Terraform apply, role `roles/owner` on the project                                                                                                                                                                                |
| Service account    | `plan@<project>` — `terraform plan` on PRs, `roles/viewer` + `roles/iam.securityReviewer`, and `roles/storage.objectAdmin` on the state bucket only                                                                                                    |
| Terraform state    | bucket `gs://<project>-tfstate` with versioning, uniform bucket-level access and public access prevention                                                                                                                                              |
| GitHub environment | `staging` or `production`, with the variables below                                                                                                                                                                                                    |

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
| `GCP_PLAN_SA`        | `plan@<project>.iam.gserviceaccount.com`                                           |
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
script carries a commented list of narrower admin roles as the alternative. Two caveats: that
list has to stay in sync as Terraform grows, and it cannot cover the billing budgets (D4) —
they live on the billing account, so whichever identity creates them needs a grant there,
which project-level Owner does not give either.

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
If the repository is renamed or transferred, re-run the script with `--repo OWNER/REPO`; the
provider is only created when missing, so also update its condition
(`gcloud iam workload-identity-pools providers update-oidc … --attribute-condition …`) or
delete the provider and run again.

## Re-running

Safe, by design: every step checks for the resource first, or re-applies an idempotent
update (APIs, bucket settings, IAM bindings, variables). A re-run never modifies protection
rules on an existing GitHub environment and never touches a resource it did not create.

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
  --member="serviceAccount:plan@openharness-dev.iam.gserviceaccount.com" --role=roles/viewer
gcloud projects remove-iam-policy-binding openharness-dev \
  --member="serviceAccount:plan@openharness-dev.iam.gserviceaccount.com" --role=roles/iam.securityReviewer
gcloud iam service-accounts delete deploy@openharness-dev.iam.gserviceaccount.com
gcloud iam service-accounts delete plan@openharness-dev.iam.gserviceaccount.com
gcloud iam workload-identity-pools providers delete github \
  --workload-identity-pool=github --location=global --project=openharness-dev
gcloud iam workload-identity-pools delete github --location=global --project=openharness-dev
gcloud storage rm --recursive gs://openharness-dev-tfstate/
```

The workload-identity bindings sit on the service accounts and go with them. The bucket
command is teardown only — after the first apply it holds the Terraform state. The APIs stay
enabled; disabling them is not part of this undo.
