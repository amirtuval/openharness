variable "project_id" {
  description = "GCP project ID the app runs in (never the display name). Also the chart's gcpProject."
  type        = string
}

variable "release_name" {
  description = "Helm release name. The namespace is created by this release."
  type        = string
  default     = "openharness"
}

variable "namespace" {
  description = "Kubernetes namespace the release is installed into."
  type        = string
  default     = "openharness"
}

variable "kubernetes_service_account" {
  description = "Kubernetes service account the chart creates and the app GCP service account is bound to."
  type        = string
  default     = "openharness"
}

variable "app_service_account_email" {
  description = "Email of the app GCP service account (created in the environment root, so the kms and secrets modules can bind their IAM to it without a module cycle)."
  type        = string
}

variable "project_roles" {
  description = "Project-level roles for the app service account. Every one of them must be in the setup script's DEPLOY_GRANTABLE_PROJECT_ROLES or the apply is denied. roles/cloudsql.client is what the Cloud SQL Auth Proxy sidecar connects as (#159): cloudsql.instances.connect, and nothing more."
  type        = list(string)
  default = [
    "roles/cloudsql.client",
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ]
}

variable "image_repository" {
  description = "Artifact Registry repository path, without the tag."
  type        = string
}

variable "image_tag" {
  description = "Image tag to deploy — the git SHA the deploy workflow passes with -var image_tag=<sha>."
  type        = string
}

variable "host" {
  description = "Public hostname, e.g. staging.oharness.dev. Becomes the Gateway listener's hostname, both HTTPRoutes' hostnames and BETTER_AUTH_URL."
  type        = string
}

variable "static_ip_name" {
  description = "Name of the reserved global address, claimed by the Gateway. Defaults to the release name."
  type        = string
  default     = ""
}

variable "certificate_map_name" {
  description = "Name of the Certificate Manager certificate map holding the host's certificate, from the certs module. It is the Gateway's `networking.gke.io/certmap` annotation; with none set, the Gateway is rendered without TLS and the HTTPS listener serves the default certificate."
  type        = string
  default     = ""
}

variable "kms_key_id" {
  description = "Crypto key resource name for the vault (OPENHARNESS_KMS_KEY), from the kms module."
  type        = string
}

variable "database_url_secret_id" {
  description = "Secret ID of the database-url secret, from the secrets module."
  type        = string
}

variable "cloudsql_instance_connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance), from the cloudsql module's instance_connection_name output. It is the Cloud SQL Auth Proxy sidecar's target (#159)."
  type        = string
}

variable "better_auth_secret_id" {
  description = "Secret ID of the better-auth-secret secret, from the secrets module."
  type        = string
}

variable "provider_secret_ids" {
  description = "Secret IDs of the provider client secrets, keyed by provider (google, github, microsoft), from the secrets module."
  type        = map(string)
  default     = {}
}

variable "google_client_id" {
  description = "Google OAuth client ID; empty means the app is not offered Google sign-in and no GOOGLE_CLIENT_SECRET is mounted."
  type        = string
  default     = ""
}

variable "github_client_id" {
  description = "GitHub OAuth client ID; empty means the app is not offered GitHub sign-in and no GITHUB_CLIENT_SECRET is mounted."
  type        = string
  default     = ""
}

variable "microsoft_client_id" {
  description = "Microsoft OAuth client ID; empty means the app is not offered Microsoft sign-in and no MICROSOFT_CLIENT_SECRET is mounted."
  type        = string
  default     = ""
}

variable "microsoft_tenant_id" {
  description = "Microsoft tenant ID; only set as OPENHARNESS's MICROSOFT_TENANT_ID when non-empty."
  type        = string
  default     = ""
}

variable "trace_sample_rate" {
  description = "OPENHARNESS_TRACE_SAMPLE_RATE (#158): the fraction of traces exported to Cloud Trace. A tenth by default — enough to see what a deployment is doing without paying to store every turn's spans."
  type        = number
  default     = 0.1

  validation {
    condition     = var.trace_sample_rate >= 0 && var.trace_sample_rate <= 1
    error_message = "The trace sample rate is a fraction between 0 and 1."
  }
}

variable "chart_path" {
  description = "Path to the Helm chart. Defaults to ../../../charts/openharness, relative to this module."
  type        = string
  default     = ""
}

variable "helm_timeout" {
  description = "Seconds helm_release waits for the release to become ready before it gives up and (with atomic = true) rolls the release back. 600 rather than the old 900 (#159): a rollout that has not converged in ten minutes is broken, and every second past that is a second the failed release is held open. A cold environment is slower — a first deploy's nodes still have to pull the image before the pods can start — so raise it with -var helm_timeout=<seconds> if one needs longer."
  type        = number
  default     = 600
}
