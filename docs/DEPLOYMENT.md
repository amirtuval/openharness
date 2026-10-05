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
call. Set it to turn alerting on:

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

### What is deliberately off

**Load-balancer request logging stays off.** It is the single most expensive thing in this
picture — every request is a log entry — and the server's own structured logs already carry
the request path and status, joined to the trace. Turning it on is a per-backend change in
Cloud Logging that this configuration does not make.
