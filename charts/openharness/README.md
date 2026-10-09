# openharness

The openharness server on GKE: the API under `/v1` and the web app at `/`, from the one image
`docker/Dockerfile` builds, behind Google's global external HTTPS load balancer with Cloud CDN
(deployment epic [#148](https://github.com/amirtuval/openharness/issues/148), issues
[#154](https://github.com/amirtuval/openharness/issues/154) and
[#159](https://github.com/amirtuval/openharness/issues/159)).

The load balancer is a **GKE Gateway** (GatewayClass `gke-l7-global-external-managed`), not a
`networking.k8s.io/v1` Ingress. The Ingress the chart used to render was never claimed: its
`spec.ingressClassName: gce` names an `IngressClass` object, the cluster has none
(`kubectl get ingressclass` → No resources found), and no forwarding rule or backend service
was ever created. A GatewayClass is owned by the controller by name, so nothing has to be
looked up.

Terraform installs this chart with `helm_release` — **Terraform is the only thing that
deploys** — and passes every environment-specific value in from its own variables. The chart
itself holds safe defaults for no environment in particular and renders on its own.

```bash
helm lint charts/openharness
helm template openharness charts/openharness -n openharness \
  -f charts/openharness/ci/staging-values.yaml \
  | kubeconform -strict -summary -ignore-missing-schemas \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
```

The second `-schema-location` is what gets the Gateway API and GKE policy objects _validated_
rather than skipped: the CRDs-catalog has `gateway.networking.k8s.io/{gateway,httproute}_v1`,
`networking.gke.io/{healthcheckpolicy,gcpbackendpolicy}_v1` and the `secrets-store.csi.x-k8s.io`
`SecretProviderClass`, so every field name in this chart is checked against a real schema.
`-ignore-missing-schemas` stays for `GCPHTTPFilter`, which the catalog does not carry yet.

## What it creates

| object                      | why                                                                                                                                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deployment`                | the server: non-root, read-only rootfs, no capabilities, `/health` liveness, `/ready` readiness, a startup probe that outlives migrations; plus the Cloud SQL Auth Proxy native sidecar when `cloudSqlProxy.enabled` |
| `Service`                   | ClusterIP, **no annotations** — the Gateway controller creates the standalone NEG itself and owns the annotation it uses for it                                                                                      |
| `ServiceAccount`            | `openharness`, annotated with the app GSA — the pod's Workload Identity                                                                                                                                              |
| `Gateway`                   | class `gke-l7-global-external-managed`, the `https` (443) and `http` (80) listeners, the global static IP (`spec.addresses`, `NamedAddress`) and the `networking.gke.io/certmap` annotation                          |
| `HTTPRoute` (`openharness`) | everything on the `https` listener → the Service on port 3000, with the CDN `ExtensionRef` filter while the CDN is on                                                                                                |
| `HTTPRoute` (`…-redirect`)  | the `http` listener: a `RequestRedirect` filter to `https`, 301 — the FrontendConfig's job                                                                                                                           |
| `GCPHTTPFilter`             | Cloud CDN on the route, `cacheMode: USE_ORIGIN_HEADERS` (only while `gateway.cdn.enabled`)                                                                                                                           |
| `HealthCheckPolicy`         | the backend service's health check: HTTP, port 3000, `/ready`                                                                                                                                                        |
| `GCPBackendPolicy`          | `timeoutSec` for SSE, connection draining; no access logging                                                                                                                                                         |
| `HorizontalPodAutoscaler`   | CPU-based scale between `minReplicas` and `maxReplicas`                                                                                                                                                              |
| `PodDisruptionBudget`       | `minAvailable: 1` — a drain or an upgrade never takes the last pod                                                                                                                                                   |
| `SecretProviderClass`       | only when `secrets` is non-empty: the Secret Manager secrets the CSI volume mounts                                                                                                                                   |

With the default values — an empty `gateway.host` — none of the six networking objects above is
rendered; with `secrets: []` the `SecretProviderClass`, the CSI volume and the volume mount are
not rendered either.

TLS is **not** in this chart: the Gateway names a [Certificate Manager](https://docs.cloud.google.com/certificate-manager/docs/overview)
certificate map, and `infra/modules/certs` creates the authorization, the certificate and the
map. That is why there is no `spec.listeners[].tls` block — naming a map in the annotation _and_
a `tls.certificateRefs` on one Gateway is an error GKE rejects.

## The chart ⇄ Terraform contract

Release name `openharness`, namespace `openharness`. Terraform's `helm_release` uses
`create_namespace = true`, points at `charts/openharness`, and sets every key marked **(TF)**
below per environment (staging `openharness-dev`, production `openharness-510710`). The
Kubernetes service account is named `openharness`.

### Values

| key                                          | (TF) | default        | what it does                                                                                 |
| -------------------------------------------- | :--: | -------------- | -------------------------------------------------------------------------------------------- |
| `image.repository`                           |  ✔   | `""`           | the image, without a tag: `us-central1-docker.pkg.dev/<project>/openharness/server`          |
| `image.tag`                                  |  ✔   | `""`           | the tag — a git sha, one image per commit, promoted by digest. **Required in practice**      |
| `image.pullPolicy`                           |      | `IfNotPresent` | the tag is immutable per commit, so a node never needs to re-pull it                         |
| `replicaCount`                               |      | `2`            | the pods the Deployment declares; the HPA owns the count when `autoscaling.enabled`          |
| `autoscaling.enabled`                        |      | `true`         | render the HPA                                                                               |
| `autoscaling.minReplicas`                    |      | `2`            | the floor                                                                                    |
| `autoscaling.maxReplicas`                    |  ✔   | `4`            | the ceiling                                                                                  |
| `autoscaling.targetCPUUtilizationPercentage` |      | `70`           | scale on CPU, as a percentage of the **request** below                                       |
| `resources.requests.cpu`                     |      | `250m`         | Autopilot schedules and bills on requests; 250m is Autopilot's floor for a container         |
| `resources.requests.memory`                  |      | `512Mi`        | the other half of Autopilot's floor                                                          |
| `resources.limits.memory`                    |      | `512Mi`        | equal to the request: a steady footprint, so a higher limit buys nothing                     |
| `serviceAccount.name`                        |      | `openharness`  | the KSA the pods run as — and the name the Workload Identity binding uses                    |
| `serviceAccount.gcpServiceAccount`           |  ✔   | `""`           | the app GSA's email → the `iam.gke.io/gcp-service-account` annotation                        |
| `cloudSqlProxy.enabled`                      |  ✔   | `false`        | render the Cloud SQL Auth Proxy as a native sidecar in the pod                               |
| `cloudSqlProxy.instanceConnectionName`       |  ✔   | `""`           | `<project>:<region>:<instance>` — the proxy's target. **Required when `enabled`**            |
| `cloudSqlProxy.image.repository`             |      | the connector  | `gcr.io/cloud-sql-connectors/cloud-sql-proxy`                                                |
| `cloudSqlProxy.image.tag`                    |      | `2.26.0`       | pinned to a release, never `latest`                                                          |
| `cloudSqlProxy.port`                         |      | `5432`         | the loopback port the proxy listens on, and the port in `database_url`                       |
| `cloudSqlProxy.privateIp`                    |      | `true`         | pass `--private-ip`: the instance has no public address                                      |
| `cloudSqlProxy.resources`                    |      | `100m`/`128Mi` | requests for the forwarder; Autopilot rounds them up to its container floor                  |
| `gateway.host`                               |  ✔   | `""`           | the serving host. Empty ⇒ none of the Gateway objects is rendered                            |
| `gateway.staticIpName`                       |  ✔   | `""`           | the `google_compute_global_address` name → the Gateway's `spec.addresses` (`NamedAddress`)   |
| `gateway.certificateMapName`                 |  ✔   | `""`           | the Certificate Manager map → `networking.gke.io/certmap` on the Gateway                     |
| `gateway.cdn.enabled`                        |      | `true`         | render the `GCPHTTPFilter` and attach it to the HTTPS route, `cacheMode: USE_ORIGIN_HEADERS` |
| `backend.timeoutSec`                         |      | `3600`         | the load balancer's request timeout — long, because SSE streams live for a turn              |
| `backend.drainingTimeoutSec`                 |      | `30`           | connection draining; at least the server's `OPENHARNESS_DRAIN_TIMEOUT_MS`                    |
| `terminationGracePeriodSeconds`              |      | `60`           | longer than the drain timeout and the connection draining, so shutdown finishes cleanly      |
| `gcpProject`                                 |  ✔   | `""`           | the GCP project in each Secret Manager `resourceName`; unused when `secrets` is empty        |
| `env`                                        |  ✔   | `{}`           | plain, non-secret env vars, name → string                                                    |
| `secrets`                                    |  ✔   | `[]`           | `{ env: NAME, secret: <id> }` — Secret Manager secrets, mounted and read via `<NAME>_FILE`   |

`helm lint` renders an extra pass for `ci/staging-values.yaml`, and the CI job renders it
before `kubeconform` validates it, so the examples below are checked on every change to
`charts/**`.

### Plain environment (`env`)

Terraform passes, per environment:

| variable                         | value                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| `BETTER_AUTH_URL`                | `https://<gateway.host>`                                              |
| `OPENHARNESS_TRUSTED_PROXY_HOPS` | `1` — the load balancer appends one entry to `x-forwarded-for` (#151) |
| `OPENHARNESS_KEY_PROVIDER`       | `gcp-kms` — Cloud KMS wraps the vault's keys (#150)                   |
| `OPENHARNESS_KMS_KEY`            | the `cryptoKeys/…` resource name (a resource name, not a secret)      |
| `OPENHARNESS_LOG_FORMAT`         | `json` — Cloud Logging reads the server's stdout as JSON (#158)       |
| `OPENHARNESS_TRACING`            | `cloud-trace` — spans go to Cloud Trace (#158)                        |
| `OPENHARNESS_TRACE_SAMPLE_RATE`  | `0.1` — the fraction of traces kept (#158)                            |
| a provider's `*_CLIENT_ID`       | only when that provider is set for the environment                    |

The chart also sets `PORT=3000`, `TMPDIR=/tmp` and `HOME=/tmp` itself: the container's port,
and where the two writable paths point on a read-only root filesystem. `env` is for the app's
own settings.

`OPENHARNESS_DEV_LOGIN` is deliberately **not** among them: the dev login is off by being
unset, and the server refuses to boot on any value other than `1`/`true`, so setting it to
`0` crash-loops the pod (#159). `ci/staging-values.yaml` mirrors what Terraform passes and a
server test boots from it (`apps/server/src/chart-values.test.ts`).

### Secrets (`secrets`)

Each entry mounts one Secret Manager secret through the GKE Secret Manager add-on:

- the CSI driver is `secrets-store-gke.csi.k8s.io` (the add-on's, not the open-source
  `secrets-store.csi.k8s.io`), and the provider is `gke`;
- a `SecretProviderClass` (`secrets-store.csi.x-k8s.io/v1`) fetches
  `projects/<gcpProject>/secrets/<secret>/versions/latest` into the path `<secret>`;
- the volume is mounted read-only at `/var/run/secrets/openharness/`, and the container is
  given `<env>_FILE=/var/run/secrets/openharness/<secret>` — the server reads the file
  ([#154](https://github.com/amirtuval/openharness/issues/154); see the server's `AGENTS.md`).

`latest` is deliberate and not pinned: the driver resolves the version at pod start, so a
secret version Terraform replaces — `database-url`, every time the instance's private IP or
password changes — reaches the pods of the next rollout with no extra step. A pinned version
would leave new pods mounting the old value.

Terraform passes `{env: DATABASE_URL, secret: database-url}` and
`{env: BETTER_AUTH_SECRET, secret: better-auth-secret}`, plus a provider's client secret
(`{env: <PROVIDER>_CLIENT_SECRET, secret: <provider>-client-secret}`) only when that provider's
client ID is set. The GSA needs `roles/secretmanager.secretAccessor` on each secret — a
Terraform grant, not the chart's. With `secrets: []` there is no CSI volume, no volume mount
and no `SecretProviderClass`.

### The Cloud SQL Auth Proxy sidecar (`cloudSqlProxy`)

Off by default — with the defaults, or `enabled: false`, nothing below is rendered and the pod
has its single container.

Why it exists ([#159](https://github.com/amirtuval/openharness/issues/159)): the instance is
private-IP only with `ssl_mode = ENCRYPTED_ONLY`, and its server certificate is signed by a
per-instance Google CA. `node-postgres` reads `sslmode=require` as verify-full, so connecting
to the instance's IP directly fails the session store's boot migration with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The fix is a proxy that terminates that TLS for the pod
rather than turning verification off: the app connects to the proxy on `127.0.0.1` with plain
Postgres (`sslmode=disable` — the hop is pod-local, over a loopback nothing else can reach), and
the proxy speaks TLS to Cloud SQL over the instance's private IP.

With `enabled: true` the chart renders an **init container with `restartPolicy: Always`** — a
[native sidecar](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
(Kubernetes 1.29+, so GKE 1.29+; the cluster is 1.35):

- it starts before the app container, and because it declares a `startupProbe` the app
  container does not start until that probe passes — which is what the app needs, since it runs
  the session store's migrations at boot and must find the database immediately;
- it is not reaped when it exits: a native sidecar stays up for the pod's lifetime;
- it authenticates as the pod's **Workload Identity**, so the app GSA needs
  `roles/cloudsql.client` — a Terraform grant, not the chart's.

| part            | value                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| args            | `<instanceConnectionName>`, `--private-ip`, `--port=<port>`, `--address=127.0.0.1`, `--structured-logs`, `--health-check`, `--http-address=0.0.0.0`, `--http-port=9090` |
| `startupProbe`  | `/startup` on 9090 — the gate the app container waits behind                                                                                                            |
| `livenessProbe` | `/liveness` on 9090 — the proxy's own event loop                                                                                                                        |
| securityContext | the app container's: `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, all capabilities dropped                                              |

`instanceConnectionName` is **required** when `enabled` is true: rendering fails with a
`required` message rather than shipping a proxy with nothing to connect to. Terraform passes
the `cloudsql` module's `instance_connection_name` output and turns it on for both
environments.

### Probes and health checks

| where               | path      | what it means                                                                                                                                            |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `livenessProbe`     | `/health` | the process is alive — never touches the database                                                                                                        |
| `readinessProbe`    | `/ready`  | 503 while the store is down or the pod is draining (#151)                                                                                                |
| `startupProbe`      | `/health` | generous (5s × 60), so a first boot's migrations are not killed as unhealthy                                                                             |
| `HealthCheckPolicy` | `/ready`  | GKE does **not** infer the backend service's health check from the readiness probe, so the policy names it explicitly; a draining pod leaves the backend |

`terminationGracePeriodSeconds` must stay longer than the server's drain timeout
(`OPENHARNESS_DRAIN_TIMEOUT_MS`, 5s by default) and than `backend.drainingTimeoutSec`; the
defaults are 60 > 30 > 5.

### The CDN (`gateway.cdn`)

`GCPHTTPFilter` is GKE's Cloud CDN extension for a Gateway, attached to a route the standard
Gateway API way — an `ExtensionRef` in the rule's filters, and one filter at most per path rule.
It requires **GKE ≥ 1.35.2-gke.1751000**; the cluster is 1.35.8-gke.

`cacheMode: USE_ORIGIN_HEADERS` is the mode the old `BackendConfig` asked for, and the reason
the server's per-route `Cache-Control` is a guarantee rather than a hint: in this mode the CDN
caches exactly what the origin says, and a response carrying `Cache-Control: no-store` — which
is `index.html`, `/v1/*`, `/api/auth/*`, `/health`, `/ready`, `/device` and **every** non-2xx —
is never stored. Only `FORCE_CACHE_ALL`, which this filter does not ask for, overrides that.

The CDN is inline on the same hostname: there is no separate CDN domain and the Vite base stays
`/`. Turning `gateway.cdn.enabled` off renders no `GCPHTTPFilter` and no filter on the route —
the load balancer then serves straight from the pods.

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
