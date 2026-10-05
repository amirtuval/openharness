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

## The workflows

Three workflows under `.github/workflows`, and one rule that governs all of them: every value
they pass to Terraform comes from a GitHub variable, and no project ID, hostname or image
path is written into a workflow.

| Workflow                | Runs on                                                   | What it does                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform-pr.yml`      | a pull request touching `infra/**`, `charts/**` or itself | `terraform fmt`/`validate`/`tflint`, `helm lint` + `helm template` when the chart exists, and a `terraform plan` per environment, posted as one collapsed PR comment |
| `deploy-staging.yml`    | a successful `CI` run on `main`, or by hand with a SHA    | builds and pushes the image for that commit, applies staging, waits for the rollout, smoke tests `staging.oharness.dev`                                              |
| `deploy-production.yml` | a push of the tag `production`                            | verifies the image already exists, applies production with it, waits for the rollout, smoke tests `app.oharness.dev`                                                 |

`terraform-pr.yml` calls `terraform-ci.yml` (the format/validate/lint jobs, no credentials)
rather than repeating them, and adds the credentialed jobs on top. It uses **`pull_request`,
never `pull_request_target`**: the plan runs against the PR's own tree, and the plan job is
skipped outright when `github.event.pull_request.head.repo.full_name` is not this repository,
so a fork gets no plan at all. It authenticates as `tf-plan@` with the repository-level
variables (`*_STAGING` / `*_PRODUCTION`), because a job outside a GitHub environment cannot
read the environment-scoped copies.

Each plan passes `image_tag` = the tag that environment currently runs, read from remote state
with `terraform output -raw image_tag`; an environment with no state yet is skipped with a
note in the comment, since a plan of an empty project cannot render the release.

### Releasing

Production deploys on a tag, and the tag is the release's identity — a moving pointer, not an
immutable marker. Cut one from any commit that has already deployed to staging:

```bash
git tag -f production <sha>
git push -f origin production
```

The workflow resolves the tag's commit, checks that
`us-central1-docker.pkg.dev/openharness-dev/openharness/server:<sha>` already exists in the
staging registry, and **fails if it does not**: production never builds an image. So the order
is always the same — a commit reaches `main`, CI passes, `deploy-staging` builds and deploys
it, you check staging, and only then do you point the tag at it.

### Rolling back

Re-point the tag at the commit that was good:

```bash
git tag -f production <earlier-sha>
git push -f origin production
```

The workflow applies `image_tag=<that sha>`, which rolls the release back to the image it built
then. That is why the tag is force-updated rather than immutable: rolling back is moving the
tag, and the registry keeps every image it has pushed. Rolling back does not revert Terraform
state — a schema migration is not undone by an older image — so treat a rollback as "run the
previous server build", and fix forward if the change was a migration.

### Re-running a staging deploy

`deploy-staging` runs by hand from Actions (`workflow_dispatch`), with an optional SHA:

- with a SHA, it deploys exactly that commit — the usual way to re-run a deploy that failed
  after the build, or to redeploy an older build;
- without one, it deploys whatever `main` is at the moment you press the button.

Re-running is safe and idempotent: the build step checks whether the image already exists and
skips the build if it does, and `terraform apply` is a no-op when nothing changed.
`concurrency: deploy-staging` with `cancel-in-progress: false` means two deploys queue rather
than race, and a staging deploy never cancels the one before it.

### The first deploy

The order matters, and only the first time. Staging exists before production, because
production's zone delegates `staging.oharness.dev` to staging's name servers and pulls images
from staging's registry.

1. **Run the setup script for both projects** (`.github/setup/README.md`), then set the two
   variables the script cannot know: `TF_EXISTING_ZONE_NAME_PRODUCTION` and — after step 3
   below — `TF_STAGING_NAME_SERVERS`. See
   [Variables the workflows read](#variables-the-workflows-read).
2. **Add the OAuth client secrets** you intend to use before they are turned on: a provider's
   secret with no version blocks its pod from starting
   ([`infra/README.md`](../infra/README.md#manual-steps), step 3).
3. **Deploy staging** — merge to `main`, let CI pass, and `deploy-staging` runs. The first run
   is a _two-stage apply_: the `helm` and `kubernetes` providers are configured from the
   cluster endpoint, which does not exist on a first plan, so the workflow first applies
   `-target=google_project_service.services -target=module.network -target=module.gke
-target=module.registry` and then runs the full apply. Terraform state after the first stage
   holds only the services, the VPC, the cluster and the registry. Every later deploy is the
   single apply.

   The registry is in that target list for a reason worth knowing: **the image push needs it to
   exist**, and Terraform is what creates it, so on a first deploy the targeted apply has to
   come before the build. A re-deploy skips the targeted apply and goes build → apply.

4. **Check the name servers, then set `TF_STAGING_NAME_SERVERS`** from the staging run's job
   summary — the workflow prints `terraform output -json name_servers` there for exactly this.
   Production reads it and writes the delegation; until it is set, production's `-var`
   defaults to an empty list and simply skips the NS records.
5. **Point `oharness.dev`'s nameservers at the production zone** if that is still outstanding.
   Production's own hostname (`app.oharness.dev`) is in the zone production adopts, so it
   works as soon as the domain's registration delegates to it.
6. **Cut the production tag** (`git tag -f production <sha> && git push -f origin production`)
   with the SHA staging just deployed, and watch `deploy-production`.

Two things can only be verified on the first real deploy, because they are the first time any
of this touches GCP: the two-stage apply actually finding an empty project (the detection is
`gcloud container clusters describe`, so it is the cluster — not the state — that decides), and
whether `tf-plan@` really can refresh every resource the plan walks. Everything else the
workflows do — building, pushing, applying, waiting for the rollout — is exercised on every
deploy after it.

**A first deploy is slow, and the smoke test is capped.** Creating the cluster takes about ten
minutes before the release is even rendered, and the Google-managed certificate for the domain
only issues once DNS resolves to the load balancer — on a genuinely first deploy that can take
longer than the rollout. The smoke test retries with backoff for about fifteen minutes and then
**fails** with the last observed status of each probe and a pointer at the certificate and the
DNS record, rather than hanging. Failing there is not a broken deploy: re-running staging
(`workflow_dispatch`) re-checks the same endpoints against the same build a few minutes later.

### The smoke test

Both deploy workflows run `.github/scripts/smoke-test.sh <url>` after the rollout:

| Probe          | Expected                                                            |
| -------------- | ------------------------------------------------------------------- |
| `/health`      | 200 — liveness                                                      |
| `/ready`       | 200 — readiness, which means the store answers                      |
| `/`            | an HTML content type — the web app is served                        |
| `/v1/sessions` | 401 unauthenticated — the API is up and the guard is in front of it |

The `/v1/sessions` probe is the one that matters most: `/health` is served by the process
whether or not the database is reachable, so a deployment whose `database-url` secret is
wrong passes `/health` and fails `/v1/sessions`. The 401 is asserted, not just "not 200",
because it is what tells a healthy API from a proxy that has not found its backend yet.

## Variables the workflows read

The six the setup script sets (`GCP_PROJECT_ID`, `GCP_PROJECT_NUMBER`, `GCP_WIF_PROVIDER`,
`GCP_DEPLOY_SA`, `GCP_PLAN_SA`, `TF_STATE_BUCKET`) exist in each environment and again at
repository level with a `_STAGING` / `_PRODUCTION` suffix — see
[`.github/setup/README.md`](../.github/setup/README.md#variables-it-sets). Those are the ones
the workflows read for project IDs, Workload Identity and the state bucket; no project ID is
written into a workflow.

Beyond them, every workflow reads these. **They are not set by the setup script.**

| Variable                           | Scope                                          | Read by                       | What it is                                                                                                                  |
| ---------------------------------- | ---------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `TF_EXISTING_ZONE_NAME_PRODUCTION` | repository                                     | plan job, `deploy-production` | **Required for production.** Resource name of the existing `oharness.dev` zone, from `gcloud dns managed-zones list`.       |
| `TF_STAGING_NAME_SERVERS`          | repository                                     | plan job, `deploy-production` | Staging's `terraform output -json name_servers`, printed by the first staging deploy. Unset (or `[]`) skips the delegation. |
| `GOOGLE_CLIENT_ID`                 | environment, and repo `_STAGING`/`_PRODUCTION` | plan job, deploys             | Google OAuth client ID. Empty disables Google sign-in.                                                                      |
| `GITHUB_CLIENT_ID`                 | environment, and repo `_STAGING`/`_PRODUCTION` | plan job, deploys             | GitHub OAuth client ID. Empty disables GitHub sign-in.                                                                      |
| `MICROSOFT_CLIENT_ID`              | environment, and repo `_STAGING`/`_PRODUCTION` | plan job, deploys             | Microsoft OAuth client ID. Empty disables Microsoft sign-in.                                                                |
| `MICROSOFT_TENANT_ID`              | environment, and repo `_STAGING`/`_PRODUCTION` | plan job, deploys             | Microsoft tenant ID, used only with the client ID above.                                                                    |

A deploy job runs inside its environment, so it reads the environment-scoped copy of an OAuth
variable; the plan job runs outside any environment and reads the repository-level
`_STAGING`/`_PRODUCTION` copy. If only one is set, the deploy jobs fall back to the
repository-level one — so setting the suffixed copy is enough, and the environment-scoped copy
is there for the case where staging and production should differ per environment rather than
per repository.

`TF_EXISTING_ZONE_NAME` (environment `production`) is read the same way and takes precedence
over the suffixed copy; it exists so the zone name can live inside the environment, but the
plan job needs the repository-level one regardless.

Everything else Terraform takes has a default (`infra/envs/*/variables.tf`), including the
whole budget module, which stays **off**: turning it on needs `roles/billing.costsManager` on
the billing account, which is a manual grant
([`infra/README.md`](../infra/README.md#manual-steps), step 4). To enable it, apply by hand
with `-var enable_budget=true -var billing_account_id=<id>` — the workflows deliberately do
not carry it.

## CLI releases

The CLI (`apps/tui`, the `oh` command) is the one artefact that does not leave through GCP: it
is published to npm as the public package
[`openharness`](https://www.npmjs.com/package/openharness), by hand, from
[`.github/workflows/publish-cli.yml`](../.github/workflows/publish-cli.yml) (decision D9). No
deploy job builds, publishes or tags it, and its npm dist-tags are the maintainer's to move —
server deploys never touch them. The workflow itself, the one-time npm setup it needs, and how
to move a dist-tag or verify provenance: [`RELEASING.md`](./RELEASING.md).
