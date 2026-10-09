# Infrastructure

Terraform for both openharness environments (issue
[#153](https://github.com/amirtuval/openharness/issues/153), epic
[#148](https://github.com/amirtuval/openharness/issues/148)). One GCP project per
environment, one GKE Autopilot cluster and one Cloud SQL instance per project, and the app
itself installed by a Helm release of [`charts/openharness`](../charts/openharness).
Terraform is the only thing that deploys.

```
infra/
  .tflint.hcl          # tflint config; the google ruleset, inherited by every directory below
  modules/
    registry/          # Artifact Registry (docker); instantiated in staging only
    network/           # VPC, subnet, private services access for Cloud SQL, Cloud NAT for egress
    gke/               # Autopilot cluster, Workload Identity, Secret Manager add-on, Gateway API CRDs
    cloudsql/          # Postgres, private IP, database + user, generated password
    secrets/           # Secret Manager secrets (generated and empty-for-manual), IAM for the app SA
    kms/               # key ring + key for the vault, encrypter/decrypter for the app SA
    certs/             # Certificate Manager: DNS authorization, managed certificate, certificate map + entry (#159)
    dns/               # zone, A records, the certificate CNAME, staging delegation
    app/               # global static IP, Workload Identity binding, app project roles, helm_release
    monitoring/        # uptime check + alert policies + email channel (#158, optional alerts)
    budget/            # billing budget with 50/90/100% alerts (optional)
  envs/
    staging/           # project openharness-dev, backend gs://openharness-dev-tfstate
    production/        # project openharness-510710, backend gs://openharness-510710-tfstate
```

The only thing Terraform does not own is the Workload Identity pool, the `deploy@` and
`tf-plan@` service accounts, the state buckets and the GitHub variables — those belong to
[`.github/setup/workload-identity.sh`](../.github/setup/README.md), which the maintainer runs
by hand. Terraform never grants a role to either account and never touches their bindings.

## Prerequisites

- Terraform >= 1.9, and `tflint` with the google ruleset (`tflint --init` fetches it).
- `gcloud` authenticated as an identity that can impersonate `deploy@<project>` — the deploy
  workflow does this through Workload Identity; from a laptop,
  `gcloud auth application-default login` as a user who holds the same roles works too.
- The setup script has run for both projects, so the state buckets exist.
- `roles/billing.costsManager` on the billing account, **only** if the budget is turned on —
  that is, only if `TF_BILLING_ACCOUNT_ID` is set (see [Manual steps](#manual-steps)).

## Apply order

**Staging first, then production.** Staging's zone exports the name servers production needs
to delegate `staging.oharness.dev`, and staging's registry is what production's nodes pull
images from.

```bash
cd infra/envs/staging
terraform init
terraform apply -var image_tag=<git sha>

terraform output name_servers        # feed these to production as staging_name_servers

cd ../production
terraform init
terraform apply \
  -var image_tag=<git sha> \
  -var existing_zone_name=<the oharness.dev zone's resource name> \
  -var 'staging_name_servers=["ns-cloud-a1.googledomains.com.", "..."]'
```

From then on the deploy workflow runs the applies and passes `-var image_tag=<sha>`; nothing
needs to be typed by hand. `image_tag` has no default in either environment on purpose: an
apply that does not name the image it deploys must fail rather than redeploy whatever is
already there.

A tfvars file per environment is a fine alternative to the `-var` flags, but it must not be
committed if it holds a client ID you would rather not publish (they are not secrets).

In the deploy workflows the values above come from GitHub variables, not from a laptop:
`existing_zone_name` from `TF_EXISTING_ZONE_NAME_PRODUCTION` and `staging_name_servers` from
`TF_STAGING_NAME_SERVERS` — see
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md#variables-the-workflows-read).

### The first deploy is two applies; every one after it is one

The `helm` and `kubernetes` providers are configured from the cluster's endpoint and CA, and
on a first apply those do not exist yet — Terraform cannot configure those providers (let
alone render the `helm_release`) while the cluster is still unknown. A first apply therefore
targets the cluster and its prerequisites, and the full apply follows it:

```bash
# First deploy only, on a project with no cluster yet. Staging adds -target=module.registry,
# because the image push has nowhere to go until the registry exists:
terraform apply -auto-approve -var image_tag=<sha> \
  -target=google_project_service.services \
  -target=module.network \
  -target=module.gke \
  -target=module.registry

# Always, first deploy or not:
terraform apply -auto-approve -var image_tag=<sha>
```

Both deploy workflows detect the cluster with `gcloud container clusters describe` and do
this by themselves; re-applies are the single apply. The targeted apply creates the project's
services, the VPC, the cluster and the registry, and nothing else — the second apply is what
creates Cloud SQL, the secrets, the DNS records and the release.

Two things follow from it. The first targeted apply is also where the cluster's ~10-minute
creation lands, so the deploy job's timeout and the rollout wait both have to accommodate a
first deploy that is much slower than the ones after it. And a targeted apply leaves the rest
of the configuration untouched, so nothing but the cluster is half-created: if it fails
partway, re-running the same two applies converges.

### The first production deploy grants registry read only once its account exists

Staging's registry grants read to **both** node service accounts, and production's does not
exist until production's own Terraform has run. GCP rejects an IAM policy that names a member
that does not exist, so a first staging apply must not name production's account at all — that
is what `production_node_service_account` being empty (its default) means, and it is why the
first staging deploy no longer fails on the registry's IAM. The account is granted read later,
once it exists:

1. **Deploy staging** (`.github/workflows/deploy-staging.yml`). It creates the registry and
   grants read to staging's own node SA. Nothing names production yet.
2. **Deploy production once.** Its first apply creates the production cluster and its node
   service account. The release's rollout then fails with `ImagePullBackOff` — production's
   nodes cannot read staging's registry yet, which is expected at this point, not a broken
   deploy — and, because the release is `atomic`, that failure rolls itself back rather than
   leaving a release behind for the next attempt to trip over.
3. **Set the variable** to production's node account, whose email is predictable:
   `gh variable set TF_PRODUCTION_NODE_SA --body gke-nodes@openharness-510710.iam.gserviceaccount.com`
4. **Re-run staging** (`workflow_dispatch`). `deploy-staging.yml` passes
   `-var production_node_service_account=${{ vars.TF_PRODUCTION_NODE_SA }}`, so this apply adds
   the reader grant on the repository for production's now-existing account.
5. **Re-run production** — re-push the `production` tag, or dispatch `deploy-production.yml` by
   hand. Its nodes can read the registry now, so the rollout completes.

After that the grant is part of staging's ordinary apply and nothing here is manual again: an
empty `TF_PRODUCTION_NODE_SA` grants nothing, and a set one grants read.

### Staging's name servers, and the empty delegation

`staging_name_servers` defaults to `[]`, and an empty list **skips** the NS records: the
production apply is not blocked on staging existing. Once staging has been applied, pass its
name servers (from `terraform output name_servers`) and re-apply production. DNS delegation
is a second apply, not a first one.

### The reserved address is replaced by a change to _any_ of its attributes

`google_compute_global_address.static_ip` is the address the environment's DNS A record points
at. Every attribute of it — `description` included — forces replacement, so a cosmetic edit to
that resource releases the address and allocates a new one, and the A record follows it. That is
why its `description` still reads "ingress address" although the load balancer is a Gateway now
(`infra/modules/app/main.tf` spells this out). A PR plan caught it once already; if a plan shows
`google_compute_global_address.static_ip must be replaced`, stop and read the `# forces
replacement` line before approving.

### The first plan cannot render the Helm release

The `helm` and `kubernetes` providers are configured from the cluster's endpoint and CA, and
on a first plan those do not exist yet — so the first plan of an empty project either fails
or cannot render the `helm_release`. That is what the two-stage apply
[above](#the-first-deploy-is-two-applies-every-one-after-it-is-one) exists for, and it is
also why `terraform-pr.yml` skips the plan of an environment that has no state yet: there is
nothing in state to plan against, and a plan of an empty project cannot show the release.

### A failed rollout rolls itself back

`helm_release.app` sets `atomic = true` and `cleanup_on_fail = true`
(`infra/modules/app/main.tf`). An install or upgrade that does not become ready inside
`helm_timeout` (600s by default, a variable) is therefore **rolled back**, not left behind:

- `atomic` waits for the release to be ready, and on failure uninstalls a failed install and
  rolls a failed upgrade back to the last good revision. `wait` is implied, so a release is
  never reported created before its pods are.
- `cleanup_on_fail` deletes the resources the failed attempt created, so the rollback leaves
  no half-applied objects behind.

Both are top-level boolean arguments of the pinned provider (`hashicorp/helm` 3.3.0, in
`envs/*/.terraform.lock.hcl`) — not blocks. Before #159 neither was set, and that is what made
the first staging deploy unrecoverable: a rollout that timed out left a **failed** release in
the cluster while the failed apply wrote nothing to state, so every retry died with
`cannot re-use a name that is still in use` until someone uninstalled the release by hand.

With them set, a failed apply is safe to re-run — which is what the workflows assume ("a first
deploy that fails halfway converges when it is re-run"). The deploy workflows also collect
diagnostics when an apply fails (#159); see
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md#when-a-deploy-fails).

#### One-time recovery: the release the first staging deploy left behind

The staging cluster still holds the failed release from that first deploy, and `atomic` only
governs releases Terraform creates from now on — it does not clean up one already sitting in
the cluster. Uninstall it once, by hand, before the next apply:

```bash
gcloud container clusters get-credentials openharness --region us-central1 --project openharness-dev
helm -n openharness uninstall openharness
```

(`openharness-dev` is staging's project — the value in the `GCP_PROJECT_ID` variable of the
staging environment. Production's is `openharness-510710`. If `helm uninstall` reports no
release, there is nothing to clean up.) After that the next `deploy-staging` run installs
normally, and any future failure cleans up after itself.

## State

One bucket per project, created by the setup script, with the backend **hardcoded** in each
environment's `versions.tf` (not passed with `-backend-config`): each environment owns
exactly one bucket, its name is `<project-id>-tfstate`, and a Terraform variable cannot reach
the backend block. `terraform init -backend=false` — what CI and linting use — ignores the
block entirely.

| Environment | Backend bucket               | Prefix            |
| ----------- | ---------------------------- | ----------------- |
| staging     | `openharness-dev-tfstate`    | `terraform/state` |
| production  | `openharness-510710-tfstate` | `terraform/state` |

The `.terraform.lock.hcl` files are committed, with checksums for linux/amd64 (CI) and
macOS amd64/arm64 (a maintainer's laptop), so `terraform init` selects the same provider
builds everywhere. Regenerate after changing a provider version with
`terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64`.

## Manual steps

Everything else is Terraform; these four are not.

**1. Re-run the setup script.** This PR adds two roles — `roles/certificatemanager.editor` to
`DEPLOY_PROJECT_ROLES` and `roles/certificatemanager.viewer` to `PLAN_PROJECT_ROLES` (see
[the plan account](#the-plan-account) and
[`../.github/setup/README.md`](../.github/setup/README.md#certificate-manager-and-the-one-role-without-delete))
— so re-run it for **both** projects before this plan or apply means anything:

```bash
./.github/setup/workload-identity.sh staging
./.github/setup/workload-identity.sh production
```

Without it, two different things fail, and they look nothing alike:

- the **apply** cannot create the Certificate Manager resources, because `deploy@` does not hold
  `certificatemanager.*` yet — the `certs` module fails with a permission error;
- the **PR plan** cannot refresh them, because `tf-plan@` does not hold
  `roles/certificatemanager.viewer` — the plan job fails while refreshing, which is why
  `terraform-pr.yml` will be red until the staging re-run has happened.

**2. Find the existing production zone.** `oharness.dev` already exists in
`openharness-510710`; production adopts it with an `import` block rather than creating a
second zone, and its resource name is the required variable `existing_zone_name`:

```bash
gcloud dns managed-zones list --project openharness-510710
# NAME              DNS_NAME        VISIBILITY
# oharness-dev-zone oharness.dev.   public      ← pass "oharness-dev-zone" as existing_zone_name
```

The zone name is whatever the maintainer created it as; it is not derivable from the domain.
If the zone's `dns_name` or visibility differ from `oharness.dev.` / public, the apply will
try to replace it — check before applying.

Put the name in the repository variable `TF_EXISTING_ZONE_NAME_PRODUCTION`
(`gh variable set TF_EXISTING_ZONE_NAME_PRODUCTION --body oharness-dev-zone`), which is
where `deploy-production.yml` and the PR plan job read it from — it cannot be derived, so it
cannot be committed.

**3. Turn on a sign-in provider.** Terraform creates `google-client-secret`,
`github-client-secret` and `microsoft-client-secret` with no version, because the value is the
provider's and not Terraform's. All three containers are created **unconditionally** (#159) —
whatever the client ID variables say — so there is somewhere to put the version _before_ the
apply that mounts it. Turning a provider on is:

1. Create the OAuth app with the provider, with the callback URL
   `https://<host>/api/auth/callback/<google|github|microsoft>` (`/api/auth` is Better Auth's
   base path — `basePath` in `apps/server/src/auth.ts`). **For Microsoft**, also open **Token
   configuration** → **Add optional claim** → **ID** and tick `email` and `xms_edov` (accepting
   the Microsoft Graph `email` permission prompt): the server refuses a Microsoft sign-in that
   asserts no verified email, and those are the claims it reads. A personal account is vouched
   for by `xms_edov` — sent as the string `"1"`/`"0"`, not the `verified_*` lists — so without
   it consumer sign-in is refused with `email_not_verified`.
2. Fill the container in with the provider's secret:

   ```bash
   printf '%s' '<the client secret>' | gcloud secrets versions add google-client-secret \
     --project=openharness-dev --data-file=-
   ```

3. Set the client ID — and, for Microsoft, the tenant — as a GitHub variable, e.g.
   `gh variable set OAUTH_GOOGLE_CLIENT_ID_STAGING --body <client id>`.
4. Re-run the deploy. The app module mounts the secret once the client ID is set; a secret with
   no version blocks the pod from starting, which is why steps 2 and 3 come in that order.

Client IDs go in as variables (`google_client_id`, `github_client_id`, `microsoft_client_id`,
`microsoft_tenant_id`); they are not secrets. The exact GitHub variable names, the full
sequence and the callback URLs: [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md#turning-on-a-sign-in-provider).

**4. The billing grant, for the budget.** The `budget` module is off until
`TF_BILLING_ACCOUNT_ID` is set, because budgets live on the billing account and `deploy@` holds
no rights there. Grant the role **first**, then set the variable — every deploy and PR plan then
passes `-var enable_budget=true -var billing_account_id=<id>`, where `<id>` is the bare account
ID from the `list` output (`0107DE-963D05-222D0A`), not `billingAccounts/0107DE-963D05-222D0A`:
the provider adds that prefix itself, and a second one is the 404 this fixes (#159):

```bash
gcloud billing accounts list
gcloud billing accounts add-iam-policy-binding <BILLING_ACCOUNT_ID> \
  --member="serviceAccount:deploy@openharness-510710.iam.gserviceaccount.com" \
  --role="roles/billing.costsManager"

gh variable set TF_BILLING_ACCOUNT_ID --body <BILLING_ACCOUNT_ID>
```

One billing account serves both projects. Setting the variable without the grant fails the
apply. From a laptop the same thing is a `-var`:

```bash
terraform apply -var enable_budget=true -var billing_account_id=<BILLING_ACCOUNT_ID>
```

The budget alerts at 50%, 90% and 100% of `budget_amount` (default `100`) every month. The
amount is in the **billing account's currency**, whatever that account is denominated in —
this epic's is ILS — and no currency code is sent with it: the API documents
`Money.currencyCode` as optional and requires it to match the account when given, and answers
anything else with `400: Request contains an invalid argument`, which is what a hardcoded
`USD` produced on the first staging deploy (#159). The module's `currency_code` therefore
defaults to `null` and is omitted from the request, and the amount is set without a code
change through the repository variables `TF_BUDGET_AMOUNT_STAGING` /
`TF_BUDGET_AMOUNT_PRODUCTION`:

```bash
gh variable set TF_BUDGET_AMOUNT_STAGING --body 300
```

Unset, the deploy and the plan leave Terraform's own default in place — every apply passes
`-var budget_amount=...` only when the variable is set.

## Input variables

Every environment input, its default, and where a non-default value comes from. Only
`image_tag` (both) and `existing_zone_name` (production) have no default and must be passed.

### Both environments

| Variable                            | Default                                                         | Where the value comes from                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project_id`                        | `openharness-dev` / `openharness-510710`                        | The project's **ID**; staging and production differ. Never the display name.                                                                                                                                                         |
| `region`                            | `us-central1`                                                   | Fixed by the epic.                                                                                                                                                                                                                   |
| `image_repository`                  | `us-central1-docker.pkg.dev/openharness-dev/openharness/server` | The registry in `openharness-dev`; production pulls from it.                                                                                                                                                                         |
| `image_tag`                         | _(none — required)_                                             | `-var image_tag=<git sha>`, passed by the deploy workflow (#155).                                                                                                                                                                    |
| `host`                              | `staging.oharness.dev` / `app.oharness.dev`                     | The environment's public hostname.                                                                                                                                                                                                   |
| `app_service_account_id`            | `openharness-app`                                               | Account ID of the app's GCP service account.                                                                                                                                                                                         |
| `google_client_id`                  | `""`                                                            | GitHub variable `OAUTH_GOOGLE_CLIENT_ID_STAGING` / `_PRODUCTION`; empty disables Google sign-in. The `google-client-secret` container exists either way (#159).                                                                      |
| `github_client_id`                  | `""`                                                            | GitHub variable `OAUTH_GITHUB_CLIENT_ID_STAGING` / `_PRODUCTION`; empty disables GitHub sign-in.                                                                                                                                     |
| `microsoft_client_id`               | `""`                                                            | GitHub variable `OAUTH_MICROSOFT_CLIENT_ID_STAGING` / `_PRODUCTION`; empty disables Microsoft sign-in.                                                                                                                               |
| `microsoft_tenant_id`               | `""`                                                            | GitHub variable `OAUTH_MICROSOFT_TENANT_ID_STAGING` / `_PRODUCTION`; passed to the app only when non-empty.                                                                                                                          |
| `db_tier`                           | `db-g1-small` / `db-custom-1-3840`                              | Cloud SQL tier: shared-core in staging, a small dedicated tier in production.                                                                                                                                                        |
| `db_availability_type`              | `ZONAL` / `ZONAL`                                               | Single zone in both. HA (`REGIONAL`) in production was deferred (#153).                                                                                                                                                              |
| `db_backup_enabled`                 | `false` / `true`                                                | Automated backups.                                                                                                                                                                                                                   |
| `db_point_in_time_recovery_enabled` | `false` / `true`                                                | Point-in-time recovery.                                                                                                                                                                                                              |
| `deletion_protection`               | `false` / `true`                                                | Blocks destroy of the cluster, the database and the secrets.                                                                                                                                                                         |
| `trace_sample_rate`                 | `0.1`                                                           | `OPENHARNESS_TRACE_SAMPLE_RATE` (#158): fraction of traces sent to Cloud Trace.                                                                                                                                                      |
| `alert_email`                       | `""`                                                            | GitHub variable `TF_ALERT_EMAIL_STAGING` / `_PRODUCTION`. Empty creates no channel and no alert policies (#158).                                                                                                                     |
| `enable_budget`                     | `false`                                                         | The deploy workflows pass `true` exactly when `TF_BILLING_ACCOUNT_ID` is set, `false` otherwise — turn it on with the billing grant above, never by hand.                                                                            |
| `billing_account_id`                | `""`                                                            | GitHub variable `TF_BILLING_ACCOUNT_ID` (`gcloud billing accounts list`); the bare ID, no `billingAccounts/` prefix (#159), used only with `enable_budget`.                                                                          |
| `budget_amount`                     | `100`                                                           | Monthly budget, **in the billing account's currency** (ILS for this epic's account). GitHub variable `TF_BUDGET_AMOUNT_STAGING` / `_PRODUCTION` when set; the workflows pass no currency code, so the API uses the account's (#159). |

### Staging only

| Variable                          | Default                | Where the value comes from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dns_zone_name`                   | `staging-oharness-dev` | Resource name of the zone staging creates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `production_node_service_account` | `""`                   | Production's node service account, granted repository-level read. **Empty grants nothing**: the account is created by production's Terraform, and GCP rejects an IAM member that does not exist. Set it (repository variable `TF_PRODUCTION_NODE_SA`) after the first production deploy, then re-apply — see [The first production deploy grants registry read only once its account exists](#the-first-production-deploy-grants-registry-read-only-once-its-account-exists). Its email is predictable and needs no lookup: `gke-nodes@openharness-510710.iam.gserviceaccount.com`. |

### Production only

| Variable               | Default             | Where the value comes from                                                                                                                                                  |
| ---------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dns_name`             | `oharness.dev.`     | The adopted zone's DNS name; records and the staging delegation hang off it.                                                                                                |
| `existing_zone_name`   | _(none — required)_ | GitHub variable `TF_EXISTING_ZONE_NAME_PRODUCTION`, whose value comes from `gcloud dns managed-zones list --project openharness-510710`; see [Manual steps](#manual-steps). |
| `staging_name_servers` | `[]`                | GitHub variable `TF_STAGING_NAME_SERVERS`, set from staging's `terraform output -json name_servers` after the first staging deploy. Empty skips the delegation.             |

## Outputs

| Output                | Environment | What it is                                                                                |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `image_tag`           | both        | The tag actually deployed — PR plans read it so a plan without `-var` reuses it.          |
| `static_ip`           | both        | The reserved global address behind the Gateway.                                           |
| `url`                 | both        | `https://<host>`.                                                                         |
| `name_servers`        | staging     | The zone's name servers, fed to production as `staging_name_servers`.                     |
| `dns_zone_name`       | production  | The zone production manages.                                                              |
| `database_private_ip` | both        | Cloud SQL's private IP, for debugging from inside the VPC. Not what the app dials (#159). |

## What Terraform sets on the chart

Release `openharness`, namespace `openharness`, `create_namespace = true`, chart
`charts/openharness`. `env` and `secrets` go in as one `yamlencode`d values document, not as
`set` entries — `secrets` is a list of objects, which `set` cannot express. Everything the
chart does not see here keeps its own default.

```yaml
image:
  repository: us-central1-docker.pkg.dev/openharness-dev/openharness/server
  tag: <var.image_tag>
gcpProject: <project id> # Secret Manager resource names
serviceAccount:
  gcpServiceAccount: <app GSA email>
cloudSqlProxy:
  enabled: true # always, in a deployed environment (#159)
  instanceConnectionName: <project>:<region>:<instance> # cloudsql's instance_connection_name
gateway:
  host: staging.oharness.dev | app.oharness.dev
  staticIpName: <the reserved global address's name>
  certificateMapName: <the certificate map's name, from the certs module>
env:
  BETTER_AUTH_URL: https://<host>
  OPENHARNESS_TRUSTED_PROXY_HOPS: '1'
  OPENHARNESS_KEY_PROVIDER: gcp-kms
  OPENHARNESS_KMS_KEY: projects/<p>/locations/us-central1/keyRings/openharness/cryptoKeys/credentials
  # OPENHARNESS_DEV_LOGIN is not set: unset is how the dev login is off, and the
  # server refuses to boot on any value other than 1/true (#159).
  # observability (#158): JSON logs, Cloud Trace at the configured sample rate
  OPENHARNESS_LOG_FORMAT: json
  OPENHARNESS_TRACING: cloud-trace
  OPENHARNESS_TRACE_SAMPLE_RATE: '0.1'
  # plus GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID, MICROSOFT_CLIENT_ID and
  # MICROSOFT_TENANT_ID, each only when its variable is non-empty
secrets:
  - { env: DATABASE_URL, secret: database-url }
  - { env: BETTER_AUTH_SECRET, secret: better-auth-secret }
  # plus GOOGLE_CLIENT_SECRET / GITHUB_CLIENT_SECRET / MICROSOFT_CLIENT_SECRET,
  # each only when that provider's client ID is set
```

The pod reads each secret through the GKE Secret Manager add-on (CSI driver) as
`<env>_FILE`. `OPENHARNESS_KMS_KEY` is the crypto key's resource name, not a version.

### The Gateway's TLS: Certificate Manager, and why not ManagedCertificate (#159)

The chart renders a GKE **Gateway**, not an Ingress, and a Gateway takes its certificates from
[Certificate Manager](https://docs.cloud.google.com/certificate-manager/docs/overview) rather
than from the `ManagedCertificate` CRD the Ingress used. `infra/modules/certs` is the four
resources that produces, in the order they depend on each other:

| resource                                           | what it is                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `google_certificate_manager_dns_authorization`     | proves control of the host; hands back the CNAME the `dns` module publishes |
| `google_certificate_manager_certificate`           | the Google-managed certificate, `managed { domains, dns_authorizations }`   |
| `google_certificate_manager_certificate_map`       | the container the Gateway's `networking.gke.io/certmap` annotation names    |
| `google_certificate_manager_certificate_map_entry` | binds the hostname to that certificate inside the map                       |

Three things about the shape of it:

- **The certificate stays `PROVISIONING` until the CNAME resolves**, and the CNAME is a DNS
  authorization record (`_acme-challenge.<host>.` → a `certificatemanager.goog` target), not the
  A record. The A record is what makes the host resolve; the CNAME is what lets Google issue.
  Both are written by the `dns` module, from `certs`' and `app`'s outputs respectively.
- **`certs` depends on nothing.** The obvious design — let `certs` write its own record into the
  DNS zone — closes the loop `app.static_ip → dns → certs → app`, because `dns` needs the static
  IP from `app` and `app` needs the map name from `certs`. So the record is written by `dns`
  (its `cname_records` input) and `certs` stays a leaf. The comments on `module "certs"` in both
  environment roots say the same thing.
- **A destroy, or a replacement, needs a role `deploy@` does not hold.** `certs` sets
  `deletion_policy` from the environment's `deletion_protection` (PREVENT in production), and
  the role that creates these resources, `roles/certificatemanager.editor`, has no delete
  permission at all — see
  [`../.github/setup/README.md`](../.github/setup/README.md#certificate-manager-and-the-one-role-without-delete).

The map's name is what `gateway.certificateMapName` above carries, and the Gateway has no `tls`
block on purpose: naming a map in the annotation _and_ a `tls.certificateRefs` on the same
Gateway is an error GKE rejects.

### Cloud SQL

Postgres **18** — the newest major the provider's `database_version` accepts
(`POSTGRES_18`). Both environments are private-IP only: no public address at all
(`ipv4_enabled = false`), reachable over the private services access peering, with
`ssl_mode = ENCRYPTED_ONLY`.

|              | staging                     | production                     |
| ------------ | --------------------------- | ------------------------------ |
| Tier         | `db-g1-small` (shared-core) | `db-custom-1-3840` (dedicated) |
| Availability | `ZONAL`                     | `ZONAL`                        |
| Backups      | off                         | daily, 03:00                   |
| PITR         | off                         | on                             |
| Delete guard | off                         | on                             |

Both run a single zone. Production's HA (`REGIONAL`) was deliberately deferred: it roughly
doubles the instance's cost, and nothing in the deploy path depends on it. Turning it on is
one variable — `-var db_availability_type=REGIONAL`, or change the default in
`envs/production/variables.tf` — and the next apply updates the instance in place.

#### The app reaches it through the Cloud SQL Auth Proxy (#159)

**The app does not connect to the instance's address.** It connects to the Cloud SQL Auth Proxy
running as a native sidecar in its own pod — `postgres://…@127.0.0.1:5432/openharness?sslmode=disable`
— and the proxy makes the TLS connection to the instance over its private IP, authenticated by
the pod's Workload Identity. There is no direct path from the app to the instance.

That is a fix, not a preference. Cloud SQL's server certificate is signed by a per-instance
Google CA that is not in Node's trust store, and `node-postgres` treats `sslmode=require` as
verify-full, so connecting to the instance's private IP fails the session store's boot migration
with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — every staging pod died there. The alternatives were to
stop verifying the instance's certificate (turning TLS's guarantee into nothing) or to
terminate that TLS somewhere that _can_ verify it. The sidecar is the second one. `sslmode=disable`
describes only the pod-local loopback hop, which is why it is not a downgrade: the traffic that
leaves the pod is encrypted by the proxy.

- The proxy is rendered by the chart (`cloudSqlProxy` in
  [`charts/openharness/README.md`](../charts/openharness/README.md#the-cloud-sql-auth-proxy-sidecar-cloudsqlproxy)),
  enabled from the `app` module with the connection name from `cloudsql`'s
  `instance_connection_name` output. Nothing here configures it directly beyond those two.
- The app GSA needs **`roles/cloudsql.client`** (`cloudsql.instances.connect`, and nothing
  more). It is granted through the `app` module's `project_roles`, so it is drawn from the setup
  script's `DEPLOY_GRANTABLE_PROJECT_ROLES` like every other project-level grant.
- **`database_url` therefore names `127.0.0.1`**, and the `secrets` module no longer takes
  `db_host` — the instance's private IP is the proxy's business, not the app's.
- The instance's `ssl_mode` is left at `ENCRYPTED_ONLY`. Hardening it to
  `TRUSTED_CLIENT_CERTIFICATE_REQUIRED` — so only the proxy, which presents a client
  certificate, may connect, rather than anyone who can reach the private IP — is a **deliberate
  follow-up**: it is an instance change, and riskier than the change that fixed the boot. Do it
  on its own, with its own plan reviewed.

### Secrets

| Secret                    | Created                | Value                                                                                                                                |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `better-auth-secret`      | always, with a version | `random_password`, 48 characters, no specials                                                                                        |
| `database-url`            | always, with a version | `postgres://user:pass@127.0.0.1:5432/openharness?sslmode=disable` — built by Terraform; the proxy sidecar is on the other end (#159) |
| `google-client-secret`    | always, empty          | none; `gcloud secrets versions add` (manual step 3)                                                                                  |
| `github-client-secret`    | always, empty          | none; manual                                                                                                                         |
| `microsoft-client-secret` | always, empty          | none; manual                                                                                                                         |

All three provider containers are created whatever the client ID variables say (#159), and the
app's service account is granted `roles/secretmanager.secretAccessor` on each of them. The chart
mounts one only while that provider's client ID is set (`infra/modules/app/locals.tf`), so an
empty container is inert — and it exists early enough for the version to be added before the
provider is turned on.

There is no `OPENHARNESS_SECRETS_KEY`: the vault's master key is the Cloud KMS key, and the
app is told `OPENHARNESS_KEY_PROVIDER=gcp-kms`.

## IAM

### What `deploy@` needs, per resource

Every resource type this configuration adds, and the role in the setup script that covers it.
Nothing needed a new role for the apply itself; the one role added in this PR is for
`tf-plan@` ([below](#the-plan-account)).

| Resource(s)                                                                                                        | Role covering it                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google_project_service`                                                                                           | `roles/serviceusage.serviceUsageAdmin`                                                                                                                                                 |
| `google_compute_network`, `_subnetwork`, `google_compute_router`, `_router_nat`, `google_compute_global_address`   | `roles/compute.networkAdmin`                                                                                                                                                           |
| `google_service_networking_connection` and its peering range                                                       | `roles/servicenetworking.networksAdmin` (+ `compute.networkAdmin`)                                                                                                                     |
| `google_container_cluster`, and the objects `helm_release` creates in it                                           | `roles/container.admin`                                                                                                                                                                |
| `google_service_account` (node and app) and `google_service_account_iam_member`                                    | `roles/iam.serviceAccountAdmin`                                                                                                                                                        |
| Creating the cluster as the custom node service account                                                            | `roles/iam.serviceAccountUser`                                                                                                                                                         |
| `google_sql_database_instance`, `_database`, `_user`                                                               | `roles/cloudsql.admin`                                                                                                                                                                 |
| `google_secret_manager_secret`, `_secret_version`, `_secret_iam_member`                                            | `roles/secretmanager.admin`                                                                                                                                                            |
| `google_kms_key_ring`, `_crypto_key`, `_crypto_key_iam_member`                                                     | `roles/cloudkms.admin`                                                                                                                                                                 |
| `google_dns_managed_zone` (production's import included), `google_dns_record_set`                                  | `roles/dns.admin`                                                                                                                                                                      |
| `google_certificate_manager_dns_authorization`, `_certificate`, `_certificate_map`, `_certificate_map_entry`       | `roles/certificatemanager.editor` — the narrowest role covering all four; it has **no delete** ([why](../.github/setup/README.md#certificate-manager-and-the-one-role-without-delete)) |
| the `Gateway`, `HTTPRoute`, `HealthCheckPolicy`, `GCPBackendPolicy` and `GCPHTTPFilter` the `helm_release` creates | `roles/container.admin` — already held, no new grant: they are Kubernetes objects                                                                                                      |
| `data.google_project`                                                                                              | `roles/browser`                                                                                                                                                                        |
| `google_project_iam_member` (the app SA's four project roles)                                                      | `roles/resourcemanager.projectIamAdmin`, **conditionally** — see below                                                                                                                 |
| `google_artifact_registry_repository` and its IAM (staging only)                                                   | `roles/artifactregistry.admin` (staging only)                                                                                                                                          |
| Reading/writing the state and taking the lock                                                                      | `roles/storage.objectAdmin` on the state bucket                                                                                                                                        |
| `google_monitoring_uptime_check_config`, `_alert_policy`, `_notification_channel` (monitoring module)              | `roles/monitoring.editor` (already held — no new grant)                                                                                                                                |
| `google_billing_budget` (budget module)                                                                            | none on the project — `roles/billing.costsManager` on the billing account, by hand                                                                                                     |

One role covers no resource: `roles/logging.viewer` (#159) is what lets a deploy workflow run
`gcloud logging read` on the container's logs when a rollout fails. It is in the setup
script's `DEPLOY_PROJECT_ROLES`, so a project whose `deploy@` predates #159 needs the script
re-run for it (`.github/setup/README.md`, "Deploy roles: least privilege").

### What Terraform grants, and to whom

Terraform grants nothing to `deploy@` or `tf-plan@`. It grants roles **to the two service
accounts it creates**:

| Grantee              | Role                                                                                                          | Scope                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| node SA              | `roles/container.defaultNodeServiceAccount`                                                                   | project                                                                               |
| app SA               | `roles/cloudsql.client`, `roles/cloudtrace.agent`, `roles/logging.logWriter`, `roles/monitoring.metricWriter` | project                                                                               |
| app SA               | `roles/secretmanager.secretAccessor`                                                                          | each secret, resource-level                                                           |
| app SA               | `roles/cloudkms.cryptoKeyEncrypterDecrypter`                                                                  | the crypto key, resource-level                                                        |
| app SA               | `roles/iam.workloadIdentityUser`                                                                              | on itself, for the `openharness/openharness` KSA                                      |
| staging's node SA    | `roles/artifactregistry.reader`                                                                               | the staging repository, resource-level                                                |
| production's node SA | `roles/artifactregistry.reader`                                                                               | the staging repository, resource-level, **only while `TF_PRODUCTION_NODE_SA` is set** |

Every **project-level** grant above is a role inside the setup script's
`DEPLOY_GRANTABLE_PROJECT_ROLES` — that is the only thing the condition on `deploy@`'s
`roles/resourcemanager.projectIamAdmin` binding lets it hand out. Everything else is
resource-level (the secret, the key, the repository, the service account), which is where
this configuration puts its IAM wherever it can.

The repository read goes to **both** node service accounts, not only production's:
`roles/container.defaultNodeServiceAccount` does not include `artifactregistry.reader`, and
staging's nodes are what run the staging deployment. The grant has to be on the repository
(rather than a project role) for production's nodes anyway — the repository is in the
staging project, which their project-level roles do not reach.

Production's half of that grant is **conditional on `TF_PRODUCTION_NODE_SA`**: production's
node service account does not exist until production's Terraform creates it, and GCP rejects an
IAM member that does not exist, so a first staging apply that named it would fail the whole
registry apply. Empty is therefore the correct state on a first deploy, and setting the variable
after production's first apply is what turns the grant on
([above](#the-first-production-deploy-grants-registry-read-only-once-its-account-exists)).

### The plan account

`tf-plan@` gets `roles/viewer`, `roles/iam.securityReviewer`, `roles/secretmanager.secretAccessor`,
`roles/certificatemanager.viewer` and `roles/storage.objectAdmin` on the state bucket. **The
secretAccessor role is new in the #159 PR**: refreshing a `google_secret_manager_secret_version`
reads the secret's payload (`secretmanager.versions.access`), which Viewer does not carry —
Viewer stops at the secret's metadata. The plan job already reads those same values out of the
state bucket, so this widens how it reads them, not what it can reach.

**`roles/certificatemanager.viewer` is new in this PR**, and it is the same shape of fact:
`certs` creates four Certificate Manager resources, and a plan that refreshes them reads their
metadata (`certificatemanager.certs.get`, `certificatemanager.certmaps.get`,
`certificatemanager.dnsauthorizations.get`, `certificatemanager.certmapentries.get`). Whether
the broad `roles/viewer` happens to carry those is not something the Certificate Manager docs
state — they document read access through `roles/certificatemanager.viewer`, and the role
exists for exactly this — so the plan account is given it explicitly rather than relying on
Viewer's coverage. It is read-only: get and list, nothing else.

An **empty** provider secret (#159) needs none of that: with no version there is no payload to
read, so refreshing `google_secret_manager_secret` stays a metadata read that plain Viewer
covers. The three versionless containers this adds therefore do not raise what `tf-plan@` has
to hold — only the two generated secrets, which have versions, need the role at all.

## Checks

```bash
cd infra
terraform fmt -check -recursive
(cd envs/staging && terraform init -backend=false && terraform validate)
(cd envs/production && terraform init -backend=false && terraform validate)
tflint --init && tflint --recursive
```

`.github/workflows/terraform-ci.yml` runs exactly these with no GCP credentials — the
reusable half of the PR check (#155). `.github/workflows/terraform-pr.yml` calls it on every
pull request that touches `infra/**`, `charts/**` or itself, and adds the credentialed half:
a `terraform plan` per environment, impersonating `tf-plan@` through Workload Identity, and
one collapsed PR comment with both plans. A plan of an environment with no remote state is
skipped with a note, since a plan of an empty project cannot render the release
([above](#the-first-plan-cannot-render-the-helm-release)).
