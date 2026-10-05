# openharness

The openharness server on GKE: the API under `/v1` and the web app at `/`, from the one image
`docker/Dockerfile` builds, behind Google's global external HTTPS load balancer with Cloud CDN
(deployment epic [#148](https://github.com/amirtuval/openharness/issues/148), issue
[#154](https://github.com/amirtuval/openharness/issues/154)).

Terraform installs this chart with `helm_release` — **Terraform is the only thing that
deploys** — and passes every environment-specific value in from its own variables. The chart
itself holds safe defaults for no environment in particular and renders on its own.

```bash
helm lint charts/openharness
helm template openharness charts/openharness -n openharness \
  -f charts/openharness/ci/staging-values.yaml | kubeconform -strict -summary -ignore-missing-schemas
```

## What it creates

| object                    | why                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Deployment`              | the server: non-root, read-only rootfs, no capabilities, `/health` liveness, `/ready` readiness, a startup probe that outlives migrations |
| `Service`                 | ClusterIP, with the NEG annotation (container-native load balancing) and the BackendConfig annotation                                     |
| `ServiceAccount`          | `openharness`, annotated with the app GSA — the pod's Workload Identity                                                                   |
| `Ingress`                 | class `gce`, the host, the global static IP, the managed certificate and the HTTP→HTTPS FrontendConfig                                    |
| `ManagedCertificate`      | a Google-managed TLS certificate for the host (`networking.gke.io/v1`)                                                                    |
| `FrontendConfig`          | redirects HTTP to HTTPS                                                                                                                   |
| `BackendConfig`           | Cloud CDN (`USE_ORIGIN_HEADERS`), the `/ready` health check, `timeoutSec` for SSE, connection draining                                    |
| `HorizontalPodAutoscaler` | CPU-based scale between `minReplicas` and `maxReplicas`                                                                                   |
| `PodDisruptionBudget`     | `minAvailable: 1` — a drain or an upgrade never takes the last pod                                                                        |
| `SecretProviderClass`     | only when `secrets` is non-empty: the Secret Manager secrets the CSI volume mounts                                                        |

With the default values — an empty `ingress.host` — the `Ingress` and `ManagedCertificate` are
not rendered; with `secrets: []` the `SecretProviderClass`, the CSI volume and the volume mount
are not rendered either.

## The chart ⇄ Terraform contract

Release name `openharness`, namespace `openharness`. Terraform's `helm_release` uses
`create_namespace = true`, points at `charts/openharness`, and sets every key marked **(TF)**
below per environment (staging `openharness-dev`, production `openharness-510710`). The
Kubernetes service account is named `openharness`.

### Values

| key                                          | (TF) | default        | what it does                                                                               |
| -------------------------------------------- | :--: | -------------- | ------------------------------------------------------------------------------------------ |
| `image.repository`                           |  ✔   | `""`           | the image, without a tag: `us-central1-docker.pkg.dev/<project>/openharness/server`        |
| `image.tag`                                  |  ✔   | `""`           | the tag — a git sha, one image per commit, promoted by digest. **Required in practice**    |
| `image.pullPolicy`                           |      | `IfNotPresent` | the tag is immutable per commit, so a node never needs to re-pull it                       |
| `replicaCount`                               |      | `2`            | the pods the Deployment declares; the HPA owns the count when `autoscaling.enabled`        |
| `autoscaling.enabled`                        |      | `true`         | render the HPA                                                                             |
| `autoscaling.minReplicas`                    |      | `2`            | the floor                                                                                  |
| `autoscaling.maxReplicas`                    |  ✔   | `4`            | the ceiling                                                                                |
| `autoscaling.targetCPUUtilizationPercentage` |      | `70`           | scale on CPU, as a percentage of the **request** below                                     |
| `resources.requests.cpu`                     |      | `250m`         | Autopilot schedules and bills on requests; 250m is Autopilot's floor for a container       |
| `resources.requests.memory`                  |      | `512Mi`        | the other half of Autopilot's floor                                                        |
| `resources.limits.memory`                    |      | `512Mi`        | equal to the request: a steady footprint, so a higher limit buys nothing                   |
| `serviceAccount.name`                        |      | `openharness`  | the KSA the pods run as — and the name the Workload Identity binding uses                  |
| `serviceAccount.gcpServiceAccount`           |  ✔   | `""`           | the app GSA's email → the `iam.gke.io/gcp-service-account` annotation                      |
| `ingress.host`                               |  ✔   | `""`           | the serving host. Empty ⇒ no Ingress, no ManagedCertificate                                |
| `ingress.staticIpName`                       |  ✔   | `""`           | the `google_compute_global_address` name → `kubernetes.io/ingress.global-static-ip-name`   |
| `cdn.enabled`                                |      | `true`         | Cloud CDN on the backend service, `cacheMode: USE_ORIGIN_HEADERS`                          |
| `backend.timeoutSec`                         |      | `3600`         | the load balancer's request timeout — long, because SSE streams live for a turn            |
| `backend.drainingTimeoutSec`                 |      | `30`           | connection draining; at least the server's `OPENHARNESS_DRAIN_TIMEOUT_MS`                  |
| `terminationGracePeriodSeconds`              |      | `60`           | longer than the drain timeout and the connection draining, so shutdown finishes cleanly    |
| `gcpProject`                                 |  ✔   | `""`           | the GCP project in each Secret Manager `resourceName`; unused when `secrets` is empty      |
| `env`                                        |  ✔   | `{}`           | plain, non-secret env vars, name → string                                                  |
| `secrets`                                    |  ✔   | `[]`           | `{ env: NAME, secret: <id> }` — Secret Manager secrets, mounted and read via `<NAME>_FILE` |

`helm lint` renders an extra pass for `ci/staging-values.yaml`, and the CI job renders it
before `kubeconform` validates it, so the examples below are checked on every change to
`charts/**`.

### Plain environment (`env`)

Terraform passes, per environment:

| variable                         | value                                                            |
| -------------------------------- | ---------------------------------------------------------------- |
| `BETTER_AUTH_URL`                | `https://<ingress.host>`                                         |
| `OPENHARNESS_TRUSTED_PROXY_HOPS` | `1` — GCLB appends one entry to `x-forwarded-for` (#151)         |
| `OPENHARNESS_KEY_PROVIDER`       | `gcp-kms` — Cloud KMS wraps the vault's keys (#150)              |
| `OPENHARNESS_KMS_KEY`            | the `cryptoKeys/…` resource name (a resource name, not a secret) |
| `OPENHARNESS_DEV_LOGIN`          | `0`                                                              |
| `OPENHARNESS_LOG_FORMAT`         | `json` — Cloud Logging reads the server's stdout as JSON (#158)  |
| `OPENHARNESS_TRACING`            | `cloud-trace` — spans go to Cloud Trace (#158)                   |
| `OPENHARNESS_TRACE_SAMPLE_RATE`  | `0.1` — the fraction of traces kept (#158)                       |
| a provider's `*_CLIENT_ID`       | only when that provider is set for the environment               |

The chart also sets `PORT=3000`, `TMPDIR=/tmp` and `HOME=/tmp` itself: the container's port,
and where the two writable paths point on a read-only root filesystem. `env` is for the app's
own settings.

### Secrets (`secrets`)

Each entry mounts one Secret Manager secret through the GKE Secret Manager add-on:

- the CSI driver is `secrets-store-gke.csi.k8s.io` (the add-on's, not the open-source
  `secrets-store.csi.k8s.io`), and the provider is `gke`;
- a `SecretProviderClass` (`secrets-store.csi.x-k8s.io/v1`) fetches
  `projects/<gcpProject>/secrets/<secret>/versions/latest` into the path `<secret>`;
- the volume is mounted read-only at `/var/run/secrets/openharness/`, and the container is
  given `<env>_FILE=/var/run/secrets/openharness/<secret>` — the server reads the file
  ([#154](https://github.com/amirtuval/openharness/issues/154); see the server's `AGENTS.md`).

Terraform passes `{env: DATABASE_URL, secret: database-url}` and
`{env: BETTER_AUTH_SECRET, secret: better-auth-secret}`, plus a provider's client secret
(`{env: <PROVIDER>_CLIENT_SECRET, secret: <provider>-client-secret}`) only when that provider's
client ID is set. The GSA needs `roles/secretmanager.secretAccessor` on each secret — a
Terraform grant, not the chart's. With `secrets: []` there is no CSI volume, no volume mount
and no `SecretProviderClass`.

### Probes and health checks

| where                | path      | what it means                                                                |
| -------------------- | --------- | ---------------------------------------------------------------------------- |
| `livenessProbe`      | `/health` | the process is alive — never touches the database                            |
| `readinessProbe`     | `/ready`  | 503 while the store is down or the pod is draining (#151)                    |
| `startupProbe`       | `/health` | generous (5s × 60), so a first boot's migrations are not killed as unhealthy |
| BackendConfig health | `/ready`  | the load balancer and the NEG follow readiness, so a draining pod leaves     |

`terminationGracePeriodSeconds` must stay longer than the server's drain timeout
(`OPENHARNESS_DRAIN_TIMEOUT_MS`, 5s by default) and than `backend.drainingTimeoutSec`; the
defaults are 60 > 30 > 5.

## Security

The pod runs as the image's non-root user `node` (uid 1000, gid 1000), with
`readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, all capabilities dropped,
and the `RuntimeDefault` seccomp profile. The only writable path is an `emptyDir` at `/tmp`.
`runAsNonRoot` is enforced at both the pod and the container. The pod's Google identity comes
from the annotated ServiceAccount (Workload Identity), so no service-account key exists
anywhere.

## Development

```bash
helm lint charts/openharness
helm template openharness charts/openharness -n openharness -f charts/openharness/ci/staging-values.yaml
```

The `Deployment`'s Go templates are not YAML, so `.prettierignore` excludes
`charts/*/templates`; the values files, `Chart.yaml` and this README are formatted as usual.
