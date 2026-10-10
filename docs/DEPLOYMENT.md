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
hand — no project-level role reaches it. Grant it before setting `TF_BILLING_ACCOUNT_ID`, which
is what turns the budget on ([Variables the workflows read](#variables-the-workflows-read)).

## Infrastructure

Everything after the setup script is Terraform, under [`infra/`](../infra/README.md): one
root per environment, and reusable modules — `network`, `gke`, `cloudsql`, `secrets`, `kms`,
`certs`, `dns`, `app`, `registry` (staging only) and `budget` (optional). Terraform is the only
thing that deploys; there is no imperative deploy path.

The shape of each environment is the same. A VPC with a subnet, private services access and
Cloud NAT; an Autopilot GKE cluster with Workload Identity, the Secret Manager add-on and the
Gateway API CRDs; a private-only Cloud SQL Postgres instance with a generated password that
Terraform writes into a `database-url` secret; Cloud KMS for the vault's master key; one GCP
service account for the app, linked to the `openharness/openharness` Kubernetes service
account; a Certificate Manager certificate and certificate map for the host; and a global
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

### The database URL, and why the pod runs a proxy (#159)

The app does not dial the Cloud SQL instance. It dials the **Cloud SQL Auth Proxy**, a native
sidecar container in its own pod, and the proxy makes the TLS connection to the instance over
its private IP as the pod's Workload Identity. `database_url` — built in
`infra/modules/secrets/locals.tf` — therefore reads
`postgres://…@127.0.0.1:5432/openharness?sslmode=disable`, and the instance's private IP never
appears in it.

The first real staging deploy died the other way round. Pointed at the instance's private IP
with `sslmode=require`, the server's session-store migration failed at boot on every pod:

```
the server could not start Error: unable to verify the first certificate
  at pg-pool ... at migrate (packages/session) ... code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
```

`node-postgres` reads `sslmode=require` as verify-full, and Cloud SQL's server certificate is
signed by a per-instance Google CA that is not in Node's trust store — so verification can
never succeed by configuration alone. The sidecar is the fix that keeps verification: the proxy
is the thing that speaks TLS to Cloud SQL, and it is the thing that can be told what to trust.
`sslmode=disable` describes only the pod-local loopback hop, which nothing outside the pod can
reach; it is not a downgrade of the connection that leaves the pod.

The chart renders the sidecar from `cloudSqlProxy` (see
[`charts/openharness/README.md`](../charts/openharness/README.md#the-cloud-sql-auth-proxy-sidecar-cloudsqlproxy));
Terraform enables it in the `app` module with the connection name from the `cloudsql` module.
Both are in [`infra/README.md`](../infra/README.md#the-app-reaches-it-through-the-cloud-sql-auth-proxy-159).

Two things worth knowing about rolling it out:

- **The `database-url` secret version is replaced, and new pods do see it.** The chart's
  `SecretProviderClass` names each secret's `versions/latest`
  (`charts/openharness/templates/secretproviderclass.yaml`), not a pinned version, and the CSI
  driver resolves that at pod start — so the pods of the new ReplicaSet mount the new URL. No
  extra step is needed; the rollout itself is the fix.
- **Tightening the instance is a follow-up, not part of this change.** `ssl_mode` stays
  `ENCRYPTED_ONLY`. Moving it to `TRUSTED_CLIENT_CERTIFICATE_REQUIRED` — so only the proxy,
  which presents a client certificate, may connect, rather than anyone who can reach the
  private IP — is an instance change and is deliberately left to its own reviewed plan.

The four things Terraform cannot do alone — re-running the setup script after this change,
finding the production zone name, adding the OAuth client secrets with
`gcloud secrets versions add`, and granting the billing account `roles/billing.costsManager`
before setting `TF_BILLING_ACCOUNT_ID` — are steps in
[`infra/README.md`](../infra/README.md#manual-steps), which also carries the full variable
reference and the resource → `deploy@` role mapping.

Terraform is also where the least-privilege boundary is exercised: `deploy@` holds no
`roles/owner`, and every project-level grant Terraform makes is drawn from the setup script's
`DEPLOY_GRANTABLE_PROJECT_ROLES` list, pinned by an IAM condition on that account. The one
role the plan account gained here, `roles/secretmanager.secretAccessor`, is what
`terraform plan` needs to refresh a Secret Manager secret version.

## Exposure: the GKE Gateway (#159)

**The chart used to render an Ingress, and the Ingress was never claimed.** The first real
staging deploy left the app running with no way in, and the diagnosis is small enough to write
down:

```bash
kubectl get ingressclass
# No resources found
kubectl describe ingress openharness -n openharness
# Events: ... managed-certificate-controller ...
```

The Ingress asked for `spec.ingressClassName: gce`, which names an `IngressClass` **object** —
and the cluster has none. Without the class the Ingress had no controller, so nothing created a
forwarding rule, a backend service or a target proxy, and the only event on the object was the
managed-certificate controller noticing it had been asked for a certificate for nothing. The
global static IP was reserved, the DNS record pointed at it, and no load balancer existed to
answer.

The fix is the **Gateway API**, not a patched Ingress: a `GatewayClass` is owned by GKE's
controller by name (`gke-l7-global-external-managed`), so there is no lookup that can come back
empty. Everything the Ingress stack did is preserved, one object at a time:

| before (Ingress stack)                            | now (Gateway API)                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ingress`, class `gce`                            | `Gateway`, class `gke-l7-global-external-managed`, listeners `https` (443) and `http` (80)                                                    |
| `kubernetes.io/ingress.global-static-ip-name`     | `Gateway.spec.addresses`, `type: NamedAddress`                                                                                                |
| `ManagedCertificate` CRD                          | Certificate Manager: a DNS authorization, a managed certificate, a certificate map, a map entry (`infra/modules/certs`)                       |
| `networking.gke.io/managed-certificates`          | `networking.gke.io/certmap` on the Gateway                                                                                                    |
| `FrontendConfig` `redirectToHttps`                | an `HTTPRoute` on the `http` listener with a `RequestRedirect` filter, 301                                                                    |
| `BackendConfig` `healthCheck`                     | `HealthCheckPolicy`, HTTP port 3000 `/ready`                                                                                                  |
| `BackendConfig` `timeoutSec`/`connectionDraining` | `GCPBackendPolicy`, `timeoutSec: 3600`, `drainingTimeoutSec: 30`                                                                              |
| `BackendConfig` `cdn` (`USE_ORIGIN_HEADERS`)      | `GCPHTTPFilter` with `cacheMode: USE_ORIGIN_HEADERS`, attached by `ExtensionRef` on the HTTPS route                                           |
| Service `cloud.google.com/neg`                    | nothing — a Gateway creates **standalone NEGs** itself, and GKE documents that the annotation must not be modified on a Service it references |
| Service `cloud.google.com/backend-config`         | nothing — the policies above replace it                                                                                                       |

Three consequences worth knowing before the first deploy:

- **The certificate is not a GKE object any more.** Certificate Manager needs a **DNS
  authorization**: it hands back a CNAME record (`_acme-challenge.<host>.` → a
  `certificatemanager.goog` target), the `dns` module publishes it in the environment's zone,
  and only then does the certificate leave `PROVISIONING`. Until it does, the load balancer
  serves its default certificate — the same "waiting on DNS" state the ManagedCertificate had,
  with one more moving part.
- **The CDN still follows the origin's headers.** `USE_ORIGIN_HEADERS` means the CDN caches
  exactly what a response says, and Cloud CDN never caches a response carrying
  `Cache-Control: no-store` in that mode (only `FORCE_CACHE_ALL` overrides that). The server
  sets `no-store` on `index.html`, `/v1/*`, `/api/auth/*`, `/health`, `/ready`, `/device` and
  every non-2xx (`apps/server/AGENTS.md`, "Behind a load balancer"), so none of the dynamic
  surface is ever stored. The CDN is inline on the same hostname, and the Vite base stays `/`.
- **The client IP is unchanged.** The global external managed (Envoy) load balancer appends
  `<client-ip>,<load-balancer-ip>` to `x-forwarded-for` — one hop, as the classic one did — so
  `OPENHARNESS_TRUSTED_PROXY_HOPS=1` still resolves the real client IP, and the sign-in rate
  limiter still keys per client rather than per proxy (#151).

The chart is where the objects live (`charts/openharness/templates/gateway.yaml`,
`httproute.yaml`, `httproute-redirect.yaml`, `healthcheckpolicy.yaml`, `gcpbackendpolicy.yaml`,
`gcphttpfilter.yaml`); Terraform supplies the host, the static IP's name and the map's name
through the `gateway` values block, and creates the map itself in `infra/modules/certs`.
`deploy@` needs one new role for that — `roles/certificatemanager.editor`, the narrowest of
Certificate Manager's four predefined roles that covers all four resource types — which means
**the setup script has to be re-run for both projects** before this plan can apply; see
[`infra/README.md`](../infra/README.md#manual-steps).

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

This is the rollback you _choose_. A rollout that never becomes ready rolls itself back
automatically — see [When a deploy fails](#when-a-deploy-fails) — and that one needs no tag.

### When a deploy fails

`helm_release.app` is installed `atomic = true, cleanup_on_fail = true` (#159), so an install
or upgrade that does not become ready within `helm_timeout` (600s, the `helm_timeout` variable
of `infra/modules/app`) is **rolled back instead of left half-applied**: a failed install is
uninstalled, a failed upgrade returns to the last good revision, and the objects the failed
attempt created are deleted. Two consequences for a failed `terraform apply`:

- **It is safe to re-run.** Nothing is left in the cluster holding the release name. That is
  what used to make one bad rollout poison every retry with Helm's "cannot re-use a name that
  is still in use"; now re-dispatching the workflow (staging) or re-pushing the tag
  (production) converges.
- **The pods are already gone when the run ends**, so "look at the pods" is no longer a
  diagnosis. That is why both deploy workflows run a **Rollout diagnostics** step when an
  apply fails: cluster credentials, then `helm list -a` / `helm history` (tolerating errors),
  `kubectl get pods -o wide`, `kubectl describe pods`, recent events
  (`kubectl get events --sort-by=.lastTimestamp | tail -50`, which survive about an hour),
  current and previous container logs (`--tail=200`), and finally Cloud Logging for the
  namespace, which outlives the rollback entirely. It prints names, statuses, events and logs
  — never a secret value.

Cloud Logging is the part the rollback cannot take away:

```bash
gcloud logging read 'resource.type="k8s_container" AND resource.labels.namespace_name="openharness"' \
  --freshness=30m --limit=200
```

Reading Cloud Logging needs `roles/logging.viewer` on `deploy@`, which the setup script now
grants (#159). A project set up before that needs the script re-run for it
(`.github/setup/workload-identity.sh staging`, then `production`); until then the Cloud Logging
probe of the diagnostics step fails and everything else in it still runs. There is no
Terraform-side action for this — the role is on `deploy@`, which Terraform does not manage.

**One-time recovery for the release the first staging deploy left behind.** `atomic` governs
the releases Terraform creates from here on; it does not remove one already stuck in the
cluster. Before the next staging apply, uninstall it by hand:

```bash
gcloud container clusters get-credentials openharness --region us-central1 --project openharness-dev
helm -n openharness uninstall openharness
```

(`openharness-dev` is staging's `GCP_PROJECT_ID`. For production substitute
`openharness-510710`. `helm uninstall` reporting no release means there is nothing to clean up.)

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
2. **Decide who signs in.** The first deploy creates all three provider secret containers —
   `google-client-secret`, `github-client-secret`, `microsoft-client-secret` — empty, whatever
   the client ID variables say (#159). A provider is therefore turned on _between_ deploys:
   create the OAuth app, add its client secret, set its client ID variable, and re-run. The
   sequence is [Turning on a sign-in provider](#turning-on-a-sign-in-provider) and
   [`infra/README.md`](../infra/README.md#manual-steps), step 3.
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
   with the SHA staging just deployed, and watch `deploy-production`. Production's nodes cannot
   read staging's registry yet, so the pods sit in `ImagePullBackOff` and **this first apply is
   expected to fail** — the release never becomes ready, so `helm_timeout` expires and the
   `atomic` release rolls itself back (`helm -n openharness uninstall` by hand is not needed;
   it already happened). Production's node service account exists as of this apply, and that is
   the point of it. The failure diagnostics step prints the `ImagePullBackOff` events that say
   so. Steps 7–9 turn the read on.
7. **Set `TF_PRODUCTION_NODE_SA`** to production's node service account, whose email is
   predictable and needs no lookup:
   `gh variable set TF_PRODUCTION_NODE_SA --body gke-nodes@openharness-510710.iam.gserviceaccount.com`.
   Empty is the correct value until now: staging's registry only grants read while the account
   in that variable exists, and naming an account that does not exist yet would fail the apply.
8. **Re-run staging** (`workflow_dispatch`). This is the apply that adds the reader grant on the
   repository for production's now-existing account — staging passes
   `-var production_node_service_account=${{ vars.TF_PRODUCTION_NODE_SA }}`.
9. **Re-run production** — re-push the `production` tag, or dispatch `deploy-production.yml` by
   hand. Its nodes can read the registry now, so the rollout finishes and the smoke test runs.
   That is the end of the bootstrap: the grant is part of staging's ordinary apply from here on.

Two things can only be verified on the first real deploy, because they are the first time any
of this touches GCP: the two-stage apply actually finding an empty project (the detection is
`gcloud container clusters describe`, so it is the cluster — not the state — that decides), and
whether `tf-plan@` really can refresh every resource the plan walks. Everything else the
workflows do — building, pushing, applying, waiting for the rollout — is exercised on every
deploy after it.

### Turning on a sign-in provider

A provider is off until its client ID is set. Its secret container, though, exists from the
first deploy — all three are created empty, whatever the client ID variables say (#159), so
there is somewhere to put the value _before_ the deploy that mounts it. Doing it the other way
round is what used to be impossible: the deploy that turned a provider on was also the one that
created its secret, and a secret with no version blocks the pod from starting, so that deploy
created an empty secret, failed, and rolled itself back.

1. **Create the OAuth app** with the provider. The callback URL is
   `https://<host>/api/auth/callback/<provider>`, where the host is `staging.oharness.dev` or
   `app.oharness.dev` and the provider is `google`, `github` or `microsoft` — so
   `https://staging.oharness.dev/api/auth/callback/google`, for instance. `/api/auth` is Better
   Auth's base path (`basePath` in `apps/server/src/auth.ts`) and the provider ids are the ones
   that file enables.

   **Microsoft needs one more step in the app registration**: open **Token configuration**,
   choose **Add optional claim**, pick the **ID** token type, and tick **`email`** and
   **`xms_edov`** (accept the prompt to add the Microsoft Graph `email` permission). The guard
   in `apps/server/src/auth-profile.ts` refuses a Microsoft sign-in that asserts no verified
   email, and those two claims are how Microsoft asserts it — without them every sign-in is
   refused with `email_not_verified`. A **personal** Microsoft account is vouched for by
   `xms_edov` alone: `verified_primary_email`/`verified_secondary_email` are an Entra
   work/school thing, so `xms_edov` is not optional for consumer sign-in. Microsoft documents
   `xms_edov` as a Boolean, but the token carries it as the string `"1"`/`"0"`; the guard reads
   both spellings (`affirmativeClaim`).

2. **Add the client secret** to the container Terraform created, filling in the provider and
   the project (`openharness-dev` for staging, `openharness-510710` for production):

   ```bash
   printf %s "$SECRET" | gcloud secrets versions add google-client-secret \
     --data-file=- --project openharness-dev
   ```

3. **Set the client ID variable** for the environment — and the tenant, for Microsoft, which is
   required by that provider:

   ```bash
   gh variable set OAUTH_GOOGLE_CLIENT_ID_STAGING --body <client id>
   gh variable set OAUTH_MICROSOFT_CLIENT_ID_STAGING --body <client id>
   gh variable set OAUTH_MICROSOFT_TENANT_ID_STAGING --body <tenant id>
   ```

4. **Re-run the deploy** — dispatch `deploy-staging` by hand, or move the `production` tag.
   The next apply passes the client ID, the app module mounts the secret, and the provider
   appears on the sign-in page. Re-running is safe: the apply is idempotent and the build step
   skips an image that is already in the registry
   ([Re-running a staging deploy](#re-running-a-staging-deploy)).

**A first deploy is slow, and the smoke test is capped.** Creating the cluster takes about ten
minutes before the release is even rendered, and TLS arrives later than the release does: the
Gateway exists as soon as the chart is installed, but the Certificate Manager certificate only
issues once the **DNS authorization's CNAME** (`_acme-challenge.<host>.`) resolves — the
authorization is what proves control of the domain now, not the A record pointing at the load
balancer. On a genuinely first deploy that can take longer than the rollout. The smoke test
retries with backoff for about fifteen minutes and then **fails** with the last observed status
of each probe and a pointer at the certificate and the DNS record, rather than hanging. Failing
there is not a broken deploy: re-running staging (`workflow_dispatch`) re-checks the same
endpoints against the same build a few minutes later.

What to check when the Gateway's first deploy looks wrong, in the order the pieces depend on
each other:

```bash
# 1. Is the Gateway claimed, and does it have the address? (The Ingress never got here.)
kubectl describe gateway openharness -n openharness
kubectl get gateway openharness -n openharness -o=jsonpath='{.status.addresses[0].value}'

# 2. Did the routes attach to it? A route that did not is `Accepted: False` with the reason.
kubectl describe httproute openharness -n openharness
kubectl describe httproute openharness-redirect -n openharness

# 3. Is the certificate issued? PROVISIONING means the CNAME is not resolving yet.
gcloud certificate-manager certificates describe openharness-cert --project openharness-dev
gcloud certificate-manager dns-authorizations describe openharness-dns-auth --project openharness-dev

# 4. Is the health check the policy's, not the default (`/`, port 80)?
kubectl describe healthcheckpolicy openharness -n openharness
```

Then the two things #159 asks about, which only a live environment can answer:

- **The CDN follows the origin.** After a page load, a second request for `/assets/*` should be
  a cache `HIT` and `/v1/*`, `/api/auth/*` and `/health` should not appear in the cache at all —
  the server marks them `no-store`, and `USE_ORIGIN_HEADERS` honours that. The response headers
  are the quick check: `curl -sI https://<host>/health` carries `Cache-Control: no-store`, and
  the CDN's own `Age` header does not appear on a repeated request. A `Cache-Control` that looks
  right but an `Age` that climbs means the filter is not in the chain — check that the
  `GCPHTTPFilter` exists in the release's namespace and that the route's rule carries the
  `ExtensionRef`.
- **Rate limiting is per client, not per load balancer.** With
  `OPENHARNESS_TRUSTED_PROXY_HOPS=1`, four failed sign-ins from one address should be refused by
  the fifth (`429`, `apps/server/AGENTS.md` → "Behind a load balancer"), and a _different_
  address should still get its own attempts. If every client shares one bucket, the load
  balancer is appending a different number of `x-forwarded-for` entries than one.

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

| Variable                                            | Scope      | Read by                            | What it is                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TF_EXISTING_ZONE_NAME_PRODUCTION`                  | repository | plan job, `deploy-production`      | **Required for production.** Resource name of the existing `oharness.dev` zone, from `gcloud dns managed-zones list`.                                                                                                                          |
| `TF_STAGING_NAME_SERVERS`                           | repository | plan job, `deploy-production`      | Staging's `terraform output -json name_servers`, printed by the first staging deploy. Unset (or `[]`) skips the delegation.                                                                                                                    |
| `TF_PRODUCTION_NODE_SA`                             | repository | staging plan job, `deploy-staging` | Production's GKE node service account email, granted read on staging's registry. **Empty until production's first deploy has created the account** — setting it earlier names a member GCP rejects. See [The first deploy](#the-first-deploy). |
| `OAUTH_GOOGLE_CLIENT_ID_STAGING` / `_PRODUCTION`    | repository | plan job, deploys                  | Google OAuth client ID. Empty disables Google sign-in.                                                                                                                                                                                         |
| `OAUTH_GITHUB_CLIENT_ID_STAGING` / `_PRODUCTION`    | repository | plan job, deploys                  | GitHub OAuth client ID. Empty disables GitHub sign-in.                                                                                                                                                                                         |
| `OAUTH_MICROSOFT_CLIENT_ID_STAGING` / `_PRODUCTION` | repository | plan job, deploys                  | Microsoft OAuth client ID. Empty disables Microsoft sign-in.                                                                                                                                                                                   |
| `OAUTH_MICROSOFT_TENANT_ID_STAGING` / `_PRODUCTION` | repository | plan job, deploys                  | Microsoft tenant ID, used only with the client ID above.                                                                                                                                                                                       |
| `TF_ALERT_EMAIL_STAGING` / `_PRODUCTION`            | repository | plan job, deploys                  | Address the monitoring alerts go to (#158). Empty creates no notification channel and no alert policies.                                                                                                                                       |
| `TF_BILLING_ACCOUNT_ID`                             | repository | plan job, deploys                  | Billing account the budget is created on, as the bare ID (`gcloud billing accounts list`) — no `billingAccounts/` prefix, which the provider adds itself (#159). One account serves both projects. Unset leaves `enable_budget` off.           |
| `TF_BUDGET_AMOUNT_STAGING` / `_PRODUCTION`          | repository | plan job, deploys                  | Monthly budget amount, **in the billing account's currency** — not USD: the account is ILS, and the Budgets API rejects a budget in any other currency with a 400 (#159). Unset leaves Terraform's default, `100`, in that same currency.      |

All of these are **repository-level** variables — no GitHub environment defines them — and every
apply reads the same set, the deploys and the PR plan alike. That is deliberate: the plan job
runs outside any GitHub environment and so can only read repository-level variables, and a
single naming scheme is what makes the plan the PR shows the plan of what the deploy will do.
The `_STAGING` / `_PRODUCTION` suffix on most of them is an environment marker, not a scope;
`TF_BILLING_ACCOUNT_ID` carries none because one billing account serves both projects. The OAuth
names are not the Terraform variables' own (`google_client_id`, …) for one reason: GitHub
rejects a configuration variable whose name starts with `GITHUB_`, so `github_client_id` cannot
be spelled that way.

These are also the values that cannot be derived — an OAuth client ID is the provider's, the
zone name is whatever the maintainer created it as — so they are set by hand rather than
written into a workflow.

The six the setup script sets are the one place the environment-scoped copies are read: a
deploy job runs _inside_ its environment, so `vars.GCP_PROJECT_ID`, `vars.GCP_WIF_PROVIDER` and
`vars.GCP_DEPLOY_SA` resolve to the environment-scoped values the script wrote there, while the
plan job reads the repository-level `_STAGING` / `_PRODUCTION` copies for the same values.
`TF_EXISTING_ZONE_NAME` (environment `production`) is read the same way and takes precedence
over the suffixed copy; it exists so the zone name can live inside the environment, but the
plan job needs the repository-level one regardless.

Everything else Terraform takes has a default (`infra/envs/*/variables.tf`), including the
budget amount — `TF_BUDGET_AMOUNT_STAGING` / `_PRODUCTION` only overrides it, so an unset
variable is the same apply as no variable at all. The budget itself is on exactly while
`TF_BILLING_ACCOUNT_ID` is set — every apply passes
`-var enable_budget=true -var billing_account_id=<id>` when it is, and
`-var enable_budget=false` when it is not — so grant `roles/billing.costsManager` on the
billing account **before** setting it
([`infra/README.md`](../infra/README.md#manual-steps), step 4). The amount is denominated in
the account's currency, and the workflows pass no currency code: the `budget` module leaves
`currencyCode` out of the request and the Budgets API then uses the account's own (#159).

## CLI releases

The CLI (`apps/tui`, the `oh` command) is the one artefact that does not leave through GCP: it
is published to npm as the public package
[`@openh/cli`](https://www.npmjs.com/package/@openh/cli), by hand, from
[`.github/workflows/publish-cli.yml`](../.github/workflows/publish-cli.yml) (decision D9). No
deploy job builds, publishes or tags it, and its npm dist-tags are the maintainer's to move —
server deploys never touch them. The workflow itself, the one-time npm setup it needs, and how
to move a dist-tag or verify provenance: [`RELEASING.md`](./RELEASING.md).

## Observability

Logs, traces and alerts all use GCP's own services — no agent to install, no third-party
account, and nothing outside the free tiers at this scale (issue
[#158](https://github.com/amirtuval/openharness/issues/158)).

### Logs — Cloud Logging

With `OPENHARNESS_LOG_FORMAT=json` (which Terraform sets on both environments) the server
writes **one JSON object per line to stdout**, in the shape Cloud Logging reads without a
parser: `severity` (`DEBUG`/`INFO`/`WARNING`/`ERROR`), `message`, `time`, and
`logging.googleapis.com/trace` + `logging.googleapis.com/spanId` when the line was written
while a request was being served. A `detail` object a call site passes is merged in as
top-level fields, so a line is filterable by `session_id`, `path` and `status`. Nothing
sensitive is ever written: `authorization`, `cookie`, `*_secret`, `*_token`, `*_api_key`,
passwords and credentials are replaced with `[REDACTED]` before serialization.

Local development keeps the readable one-line format; only the deployment sets `json`.

- **Where:** Logging → Logs Explorer, project `openharness-dev` or `openharness-510710`.
  Filter by `resource.type="k8s_container"` and `resource.labels.container_name="openharness"`.
- **Volume:** a few hundred megabytes a month at this size — a couple of lines per request
  plus the startup banner. The `_Default` bucket keeps logs 30 days, and its first **50 GiB per
  project per month** are free, then $0.50/GiB — this deployment is three orders of magnitude
  below that.
- **Joining a log to its trace:** open a line with a trace id and Logs Explorer offers "View
  trace", which lands in Cloud Trace on the same request.

### Traces — Cloud Trace

With `OPENHARNESS_TRACING=cloud-trace` the server exports OpenTelemetry spans to Cloud Trace,
sampling `OPENHARNESS_TRACE_SAMPLE_RATE` of root traces (**0.1** by default). The spans are:

- one **server span per HTTP request**, continuing the trace the load balancer started (its
  `traceparent` / `X-Cloud-Trace-Context` headers are honoured), with the method, path and
  response status;
- one **turn span** per turn of a session, and one **child span per model request** built from
  the session log's `span.model_request_start` / `span.model_request_end` events, carrying the
  model and its token usage. (v1 has no tool-call events — `hands` is unused — so tool calls
  are not traced yet.)

The OpenTelemetry SDK and the Cloud Trace exporter are imported **lazily**: an untraced server
(`OPENHARNESS_TRACING=off`, the default) never loads them, so local development and CI pay
nothing.

- **Where:** Trace Explorer, project `openharness-dev` or `openharness-510710`.
- **Volume and cost:** one request is roughly 3–6 spans (the server span, a turn, and its
  model requests). At a few thousand requests a month that is well inside Cloud Trace's free
  tier of **2.5 million spans per month**; spans are kept 30 days.
- **Changing the sample rate:** it is the Terraform variable `trace_sample_rate` (0..1), passed
  to the pods as `OPENHARNESS_TRACE_SAMPLE_RATE`. It has a default of `0.1` in both environment
  roots, so either edit that default or apply with `-var trace_sample_rate=0.5` (a re-apply —
  the value reaches the pods through the Helm release). Sampling is decided per root trace and
  inherited by its child spans, so a kept request is kept whole; `0` keeps none while leaving
  the exporter wired, `1` keeps everything.

### Alerts — Cloud Monitoring

`infra/modules/monitoring`, instantiated in both environments, creates:

- an **uptime check** on `https://<host>/health`, HTTPS, every five minutes, from three probe
  regions — always created, and what the console's uptime dashboard reads;
- once `alert_email` is set: an **email notification channel**, and alert policies for the
  uptime check failing from every region for five minutes, a high load-balancer 5xx rate, Cloud
  SQL CPU above 80%, Cloud SQL disk above 80%, and containers restarting.

`alert_email` is empty by default, and an empty value creates **no channel and no alert
policies** — so the first apply of an environment succeeds before anyone has decided who is on
call. Set it to turn alerting on: the repository variable `TF_ALERT_EMAIL_STAGING` or
`TF_ALERT_EMAIL_PRODUCTION`, which every deploy and every PR plan passes as `-var alert_email`:

```bash
gh variable set TF_ALERT_EMAIL_PRODUCTION --body oncall@example.com
```

From a laptop the Terraform variable is `alert_email`:

```bash
terraform -chdir=infra/envs/production apply -var alert_email=oncall@example.com -var image_tag=<sha>
```

The thresholds are the module's own variables — `http_5xx_threshold` (5xx per second),
`db_cpu_threshold` and `db_disk_threshold` (utilization, 0..1), `container_restart_threshold`
(restarts per hour; the default `0` means "any restart") — each with a default that fits this
deployment. Override one by adding it to the `monitoring` module call.

- **Where:** Monitoring → Alerting (the policies) and Monitoring → Uptime (the check); each
  policy's documentation links to what to look at when it fires.
- **Cost:** uptime checks are billed per execution and the free tier is **1 million
  executions/month** — three regions at five-minute intervals is about 26,000 — and alerting
  policies and notification channels carry no separate charge. The metrics the alerts read are
  GCP's own (load balancer, Cloud SQL, GKE), which need no agent and are not billed as custom
  metrics.

### Private addresses for custom provider URLs, and why they stay off

A **custom OpenAI-compatible** credential is a base URL a user typed, and every request to it
goes through the SSRF guard (`safeFetch`): loopback, private, link-local and cloud-metadata
addresses are refused, on save and on every model call and `/models` listing afterwards. A
**self-hosted** deployment whose users point that credential type at a server on its own
network — an Ollama or vLLM beside the app, a gateway on a private subnet — can turn the
refusal off for that one credential type with:

```
OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1
```

It is deliberately **not set anywhere in this infrastructure**: `charts/openharness/values.yaml`
does not carry it, `charts/openharness/ci/staging-values.yaml` does not, and
`infra/modules/app/locals.tf` does not set it for any environment. Staging and production run
behind a public load balancer with sign-in to the open internet, where the guard is doing
exactly the job it exists for: a private address in a credential can only be a mistake or an
attack. The flag is for a single-tenant, self-hosted install whose operator knows the network;
turning it on here would let any signed-in user make the service connect anywhere it can
reach. It applies to the `openai_compatible` credential type alone — Azure OpenAI never reads
it — and the server says so loudly at startup when it is on
(`custom provider URLs: PRIVATE ADDRESSES ALLOWED`).

### Context compaction, and the one knob it has

When a chat's context fills, the brain summarizes the older history instead of letting it be
trimmed away (epic #277), and the only setting it has is where that starts:

```
OPENHARNESS_COMPACTION_THRESHOLD=0.7
```

It is the share of the **chat model's** context budget at which the engine summarizes before a
request — the default 0.7 leaves a comfortable margin under a provider's window, and a
deployment can lower it (summarize earlier, cheaper requests, more summaries) or raise it
(summarize later, closer to the limit). The value is validated at boot: a fraction in `0..1`,
anything else stops the server with a message naming the variable. Nothing here sets it — every
environment takes the default — and it is a single global, not a per-user preference: the
per-user choice is the follow-up work in epic #277 (C3). Nothing else about compaction is
configurable: the summary model is the chat's own, and the pass limit, the verbatim tail and the
summary's size cap are the brain's documented constants.

Two things worth knowing when reading a bill: a summary is a **model request** (its tokens and
cost appear in the session's usage like any other request), and it is charged to the model that
wrote it, which by default is the model the chat is running. The compaction job the store runs
on its own schedule (`OPENHARNESS_COMPACT_INTERVAL_MS`) is unrelated: it deletes the chunk rows
replay already skips and never summarizes anything.

### What is deliberately off

**Load-balancer request logging stays off.** It is the single most expensive thing in this
picture — every request is a log entry — and the server's own structured logs already carry
the request path and status, joined to the trace. Turning it on is a per-backend change in
Cloud Logging that this configuration does not make.
