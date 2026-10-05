# Deployment

How openharness runs on GCP: two environments, one GCP project each, deployed by GitHub
Actions. The plan and its decisions live on the deployment epic
([#148](https://github.com/amirtuval/openharness/issues/148)) — this page grows with each
wave of that epic.

Everything runs in `us-central1`, and the same image is built once per commit and promoted
by digest, never rebuilt. GitHub Actions reaches GCP only through Workload Identity
Federation — there are no service-account keys.

## Environments

| Environment | GCP project ID       | Display name      | GitHub environment | URL                    |
| ----------- | -------------------- | ----------------- | ------------------ | ---------------------- |
| staging     | `openharness-dev`    | `openharness-dev` | `staging`          | `staging.oharness.dev` |
| production  | `openharness-510710` | `openharness`     | `production`       | `app.oharness.dev`     |

The ID is what gcloud and every resource name take — the display name is only a label, and
production's `openharness` is not an ID. The setup script derives the state bucket
(`<id>-tfstate`), the service-account emails and the GitHub variables from the ID. To see
both side by side:

```bash
gcloud projects list --format="table(projectId,name)"
```

## One-time setup

`.github/setup/workload-identity.sh`, run per project by the maintainer with their own
gcloud credentials, creates the Workload Identity pool, the OIDC provider, the `deploy` and
`plan` service accounts, the Terraform state bucket and the GitHub environments and
variables. It converges on re-run: what it owns is declared in lists at the top of the
script, so after an edit a re-run creates what is missing, updates what exists, and
`--prune` removes bindings the lists no longer declare. `deploy` holds exactly the roles
Terraform needs — never Owner — and the one role it may hand out is pinned by an IAM
condition (#167). Everything else — Artifact Registry, GKE, Cloud SQL, Secret Manager — is
Terraform. Prerequisites, usage, the role list, how to run the test and how to undo it:
[`.github/setup/README.md`](../.github/setup/README.md).

The billing budget is the one grant this cannot carry: budgets live on the billing
account, so `roles/billing.costsManager` on the billing account is granted separately, by
hand — no project-level role reaches it.

## Infrastructure

Everything after the setup script is Terraform, under [`infra/`](../infra/README.md): one
root per environment, and reusable modules — `network`, `gke`, `cloudsql`, `secrets`, `kms`,
`dns`, `app`, `registry` (staging only) and `budget` (optional). Terraform is the only thing
that deploys; there is no imperative deploy path.

The shape of each environment is the same. A VPC with a subnet, private services access and
Cloud NAT; an Autopilot GKE cluster with Workload Identity and the Secret Manager add-on; a
private-only Cloud SQL Postgres instance with a generated password that Terraform writes into
a `database-url` secret; Cloud KMS for the vault's master key; one GCP service account for
the app, linked to the `openharness/openharness` Kubernetes service account; and a global
static IP, a DNS zone and a `helm_release` of [`charts/openharness`](../charts/openharness)
that ties them together. The one Artifact Registry repository lives in staging, in
`openharness-dev`; each environment's GKE nodes are granted resource-level read on it and
pull the image staging built.

**Apply staging first, then production.** Staging's zone exports the name servers production
writes as the `staging.oharness.dev` delegation, and staging holds the registry. State lives
in the bucket the setup script created, one per project (`<project-id>-tfstate`), with the
backend hardcoded per environment. The production root adopts the pre-existing `oharness.dev`
zone with an `import` block, so it needs `existing_zone_name` — the zone's resource name,
from `gcloud dns managed-zones list --project openharness-510710` — passed on the apply.

The four things Terraform cannot do alone — re-running the setup script after this change,
finding the production zone name, adding the OAuth client secrets with
`gcloud secrets versions add`, and granting the billing account `roles/billing.costsManager`
before the budget module is enabled — are steps in
[`infra/README.md`](../infra/README.md#manual-steps), which also carries the full variable
reference and the resource → `deploy@` role mapping.

Terraform is also where the least-privilege boundary is exercised: `deploy@` holds no
`roles/owner`, and every project-level grant Terraform makes is drawn from the setup script's
`DEPLOY_GRANTABLE_PROJECT_ROLES` list, pinned by an IAM condition on that account. The one
role the plan account gained here, `roles/secretmanager.secretAccessor`, is what
`terraform plan` needs to refresh a Secret Manager secret version.

## CLI releases

The CLI (`apps/tui`, the `oh` command) is the one artefact that does not leave through GCP: it
is published to npm as the public package
[`openharness`](https://www.npmjs.com/package/openharness), by hand, from
[`.github/workflows/publish-cli.yml`](../.github/workflows/publish-cli.yml) (decision D9). No
deploy job builds, publishes or tags it, and its npm dist-tags are the maintainer's to move —
server deploys never touch them. The workflow itself, the one-time npm setup it needs, and how
to move a dist-tag or verify provenance: [`RELEASING.md`](./RELEASING.md).
