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
- `jq` — every run builds the conditional binding's condition file with it, and `--prune`
  reads the current IAM policies with `gcloud ... get-iam-policy --format=json` and parses
  them with it.
- The project exists and has **billing linked**. Both projects are created by hand; the
  script creates nothing itself. What it needs is the project **ID**, which need not match
  the display name the project is known by.
- A recent gcloud, for the `gcloud billing` and `gcloud storage` command groups.

Both projects, by ID and display name:

| Environment | Project ID           | Display name      |
| ----------- | -------------------- | ----------------- |
| staging     | `openharness-dev`    | `openharness-dev` |
| production  | `openharness-510710` | `openharness`     |

Production is the case in point: its display name is `openharness`, but its ID — the only
thing gcloud accepts — is `openharness-510710`. To see both side by side:

```bash
gcloud projects list --format="table(projectId,name)"
```

## Run

For staging (project `openharness-dev`):

```bash
./.github/setup/workload-identity.sh staging --dry-run   # print every command, run nothing
./.github/setup/workload-identity.sh staging
```

Then for production (project ID `openharness-510710`, display name "openharness"):

```bash
./.github/setup/workload-identity.sh production
```

Run staging before production — that is the epic's order (D7).

| Flag                | Effect                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo OWNER/REPO` | this repository (default `amirtuval/openharness`)                                                                                             |
| `--prune`           | additionally remove the managed accounts' bindings the lists no longer declare (see [Re-running](#re-running-convergent-additive-or-pruning)) |
| `--dry-run`         | print every gcloud and gh command, execute nothing                                                                                            |

`--dry-run` needs no gcloud, gh or login at all (only jq, which renders the conditional
binding's condition file, and whose content the dry run prints); the project number, which
only gcloud can resolve, appears as `<project-number>` in its output. Because it executes
nothing, it also cannot list the exact bindings `--prune` would remove — reading those
needs the live policies — so it prints the prune rules instead.

## The lists: edit, then re-run

What the script owns is declared in bash arrays at the top of `workload-identity.sh` —
adding an API or a permission is a one-line change, and nothing else in the script needs
touching:

| List                             | What it holds                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `APIS`                           | the APIs to enable                                                                 |
| `DEPLOY_PROJECT_ROLES`           | project roles for `deploy@` — the least-privilege list, never `roles/owner` (#167) |
| `DEPLOY_PROJECT_ROLES_STAGING`   | staging-only extra: `roles/artifactregistry.admin`                                 |
| `DEPLOY_GRANTABLE_PROJECT_ROLES` | the roles inside the condition on `deploy@`'s `projectIamAdmin` binding            |
| `PLAN_PROJECT_ROLES`             | project roles for `tf-plan@`                                                       |
| `DEPLOY_STATE_BUCKET_ROLES`      | `deploy@`'s roles on the state bucket                                              |
| `PLAN_STATE_BUCKET_ROLES`        | `tf-plan@`'s roles on the state bucket                                             |
| `DEPLOY_CROSS_PROJECT_ROLES`     | production's read on the staging project                                           |

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
| Service account    | `deploy@<project>` — Terraform apply, the least-privilege role list of [Deploy roles](#deploy-roles-least-privilege)                                                                                                                                   |
| Service account    | `tf-plan@<project>` — `terraform plan` on PRs, `roles/viewer` + `roles/iam.securityReviewer`, and `roles/storage.objectAdmin` on the state bucket only                                                                                                 |
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
| `GCP_PROJECT_ID`     | `openharness-dev` / `openharness-510710` (the project IDs, not display names)      |
| `GCP_PROJECT_NUMBER` | the project number                                                                 |
| `GCP_WIF_PROVIDER`   | `projects/<number>/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA`      | `deploy@<project>.iam.gserviceaccount.com`                                         |
| `GCP_PLAN_SA`        | `tf-plan@<project>.iam.gserviceaccount.com`                                        |
| `TF_STATE_BUCKET`    | `<project>-tfstate`                                                                |

Variables only — the script creates no secrets anywhere (D5: the only Actions secret stays
`OPENAI_API_KEY`, for the provider smoke test).

The environment-scoped copies are what the deploy workflows (#155) read: they run inside the
environment, so its protection rules apply. The `_STAGING` / `_PRODUCTION` copies are for
`terraform-pr.yml`, which runs outside any environment and plans both projects.

## Deploy roles: least privilege

`deploy` never gets `roles/owner` (#167). It holds exactly the roles Terraform (wave 2,
#153) needs, each declared in `DEPLOY_PROJECT_ROLES` next to the resources it covers:

| Role                                    | Why `deploy@` holds it                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `roles/serviceusage.serviceUsageAdmin`  | enable and disable the project's APIs — `google_project_service`                                                       |
| `roles/compute.networkAdmin`            | VPC, subnet, Cloud Router/NAT and the global static address                                                            |
| `roles/servicenetworking.networksAdmin` | private services access for Cloud SQL                                                                                  |
| `roles/container.admin`                 | the GKE Autopilot cluster, and the Kubernetes objects `helm_release` creates                                           |
| `roles/iam.serviceAccountAdmin`         | the node and app service accounts, and the Workload Identity binding (IAM policy on the app account)                   |
| `roles/iam.serviceAccountUser`          | acting as the node service account when the cluster is created                                                         |
| `roles/cloudsql.admin`                  | the Cloud SQL instance, database and user                                                                              |
| `roles/secretmanager.admin`             | secrets, versions, and IAM on secrets                                                                                  |
| `roles/cloudkms.admin`                  | the key ring, key, and IAM on the key (no encrypt/decrypt)                                                             |
| `roles/dns.admin`                       | DNS zones and records, the import of the existing `oharness.dev` zone in production included                           |
| `roles/monitoring.editor`               | uptime checks, alert policies and notification channels                                                                |
| `roles/browser`                         | `resourcemanager.projects.get`, for the `google_project` data sources                                                  |
| `roles/artifactregistry.admin`          | _staging only_ (`DEPLOY_PROJECT_ROLES_STAGING`): the registry, its IAM, and the image pushes from `deploy-staging.yml` |

The list is completed by the Terraform work (#153): a role a later wave turns out to need
is added to `DEPLOY_PROJECT_ROLES` (or `DEPLOY_PROJECT_ROLES_STAGING`) in that issue's PR,
and the maintainer re-runs this script — the run grants what is new, and `--prune` drops
any binding the lists no longer declare.

### The conditional project-IAM admin

Terraform grants the service accounts it creates their own roles, so `deploy@` needs
`roles/resourcemanager.projectIamAdmin` — but granted unconditionally, that role could give
`deploy@` Owner itself. It is therefore granted with an IAM condition, title
`terraform-grantable-roles`, expression:

```cel
api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', [])
  .hasOnly(['roles/logging.logWriter', 'roles/monitoring.metricWriter', 'roles/monitoring.viewer',
            'roles/stackdriver.resourceMetadata.writer', 'roles/cloudtrace.agent', 'roles/cloudsql.client',
            'roles/cloudsql.instanceUser', 'roles/container.defaultNodeServiceAccount',
            'roles/artifactregistry.reader'])
```

The `hasOnly` list is `DEPLOY_GRANTABLE_PROJECT_ROLES`, built into the expression by the
script so the two cannot drift apart. It is what the node and app service accounts need
from Terraform and nothing more: no entry carries `setIamPolicy` permissions, and
`projectIamAdmin` itself is absent on purpose, so the condition cannot be used to widen
itself. The attribute and its limits — at most 10 roles, string constants only, no joining
several `hasOnly()` calls with `&&` or `||` — are from Google Cloud IAM, [Set limits on
granting roles](https://cloud.google.com/iam/docs/setting-limits-on-granting-roles) (the
"Delegate role granting" pattern).

The condition travels to gcloud in a temporary file (`--condition-from-file`), because the
expression holds commas and quotes that the inline `--condition=...` syntax cannot carry,
and `--dry-run` prints the file's content. A removal carries the binding's own condition
back the same way; `--prune` counts a conditional binding as declared only while role and
condition both match, so a changed condition is replaced by the run's grant, not doubled.

### Cross-project read, and the state bucket

Images are built and pushed in staging only (#152), and production promotes them by
digest. A production run grants `deploy@openharness-510710` `roles/artifactregistry.reader`
on `openharness-dev` (`DEPLOY_CROSS_PROJECT_ROLES`) so `deploy-production.yml` can verify the
image exists; Terraform gives the production GKE node account its own read access. A
production `--prune` acts on `openharness-dev` only for that one member — staging's own
accounts and everyone else's bindings there are not its to touch.

Both accounts hold `roles/storage.objectAdmin` on the state bucket only —
`DEPLOY_STATE_BUCKET_ROLES` and `PLAN_STATE_BUCKET_ROLES`. Terraform's GCS backend reads
and writes the state as `deploy@`, and `tf-plan@` reads the state and takes the lock
(create/delete of `.tflock`). Before #167 `deploy@` was declared nothing on the bucket and
`--prune` removed whatever it held; Owner hid the gap.

### Billing stays separate

The billing budget (D4) is not covered by any of this: budgets live on the billing
account, and no project-level role — Owner included — reaches them.
`roles/billing.costsManager` on the billing account is granted by hand, outside this
script.

## The plan account, and its risk

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

- project bindings of `deploy@` and `tf-plan@` that no declared pair covers — a binding
  counts as declared only when both its **role and its condition** match, so `deploy@`'s
  conditional `projectIamAdmin` binding is kept only while its condition is the declared
  one, and a stray `roles/owner` goes like any other undeclared role;
- their state-bucket roles that are not declared
  (`DEPLOY_STATE_BUCKET_ROLES` / `PLAN_STATE_BUCKET_ROLES`);
- `roles/iam.workloadIdentityUser` members on the two accounts other than the declared
  principalSet (this one uses the CLI's `--all`; the script creates only unconditional
  bindings there).

A production `--prune` additionally manages the one cross-project member it granted —
`deploy@openharness-510710` on `openharness-dev` — against `DEPLOY_CROSS_PROJECT_ROLES`, and
nothing else on that project. Everywhere else, only bindings whose member is one of the
two managed accounts are ever considered: another member's bindings — staging's own
accounts included, from a production run — are never touched. A removal carries the stale
binding's own condition back to gcloud (`--condition=None` for an unconditional binding,
`--condition-from-file` for a conditional one), so exactly the stale binding goes, never
the declared one next to it. And a run — pruned or not — never touches a resource it did
not create:

- an existing GitHub environment is not re-PUT, so its **protection rules are never
  modified**;
- another member's IAM bindings are never removed, by a normal run or by `--prune`.

## Test

`.github/setup/test/run-tests.sh` proves all of the above — converge-on-re-run, the
provider update, least privilege (no `roles/owner`, the staging-only registry, one
conditional binding per environment), `--prune` selectivity (a stray Owner included), the
changed-condition replacement, the cross-project reach of a production prune, dry-run
purity — without gcloud, gh, a login or network:

```bash
./.github/setup/test/run-tests.sh
```

It runs the real script against stateful fakes (`test/bin/gcloud.sh`, `test/bin/gh.sh`)
that keep what they are told to create in a temp directory, fail on creating what already
exists the way the real CLIs do, store and compare binding conditions, and log every
call. bash and `jq` are all it needs. CI runs it, plus `shellcheck` on every script in
this folder, in `.github/workflows/setup-script.yml` whenever `.github/setup/**` changes.

## Undo

Per environment — staging shown; the same with `openharness-510710` and `production` for
production (the project ID, not the display name `openharness`):

```bash
# GitHub
for v in GCP_PROJECT_ID GCP_PROJECT_NUMBER GCP_WIF_PROVIDER GCP_DEPLOY_SA GCP_PLAN_SA TF_STATE_BUCKET; do
  gh variable delete "$v" --repo amirtuval/openharness --env staging
  gh variable delete "${v}_STAGING" --repo amirtuval/openharness
done
gh api --method DELETE repos/amirtuval/openharness/environments/staging   # only if no workflow uses it

# GCP — deploy@ holds each role of DEPLOY_PROJECT_ROLES (plus DEPLOY_PROJECT_ROLES_STAGING
# on staging), and its conditional one goes the same way but needs --all (or that condition):
gcloud projects remove-iam-policy-binding openharness-dev \
  --member="serviceAccount:deploy@openharness-dev.iam.gserviceaccount.com" \
  --role=roles/resourcemanager.projectIamAdmin --all
# ...and one remove-iam-policy-binding per remaining role, then the bucket roles
# (DEPLOY_STATE_BUCKET_ROLES / PLAN_STATE_BUCKET_ROLES) on gs://openharness-dev-tfstate.
# A production undo also drops the cross-project read it granted on staging:
#   gcloud projects remove-iam-policy-binding openharness-dev \
#     --member="serviceAccount:deploy@openharness-510710.iam.gserviceaccount.com" \
#     --role=roles/artifactregistry.reader
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
