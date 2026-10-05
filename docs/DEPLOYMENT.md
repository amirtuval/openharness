# Deployment

How openharness runs on GCP: two environments, one GCP project each, deployed by GitHub
Actions. The plan and its decisions live on the deployment epic
([#148](https://github.com/amirtuval/openharness/issues/148)) — this page grows with each
wave of that epic.

Everything runs in `us-central1`, and the same image is built once per commit and promoted
by digest, never rebuilt. GitHub Actions reaches GCP only through Workload Identity
Federation — there are no service-account keys.

## Environments

| Environment | GCP project       | GitHub environment | URL                    |
| ----------- | ----------------- | ------------------ | ---------------------- |
| staging     | `openharness-dev` | `staging`          | `staging.oharness.dev` |
| production  | `openharness`     | `production`       | `app.oharness.dev`     |

## One-time setup

`.github/setup/workload-identity.sh`, run once per project by the maintainer with their own
gcloud credentials, creates the Workload Identity pool, the `deploy` and `plan` service
accounts, the Terraform state bucket and the GitHub environments and variables. Everything
else — Artifact Registry, GKE, Cloud SQL, Secret Manager — is Terraform. Prerequisites,
usage, role choices and how to undo it: [`.github/setup/README.md`](../.github/setup/README.md).
