# Every value below is a *default* for the staging environment. Override any of
# them with -var / a tfvars file; image_tag has no default and must be passed
# (the deploy workflow passes the git SHA).

variable "project_id" {
  description = "Staging GCP project ID (never the display name)."
  type        = string
  default     = "openharness-dev"
}

variable "region" {
  description = "GCP region."
  type        = string
  default     = "us-central1"
}

variable "image_repository" {
  description = "Artifact Registry path for the app image, without the tag. The registry lives in this project."
  type        = string
  default     = "us-central1-docker.pkg.dev/openharness-dev/openharness/server"
}

variable "image_tag" {
  description = "Image tag to deploy — the git SHA the deploy workflow passes with -var image_tag=<sha>. No default: an unpinned apply must fail."
  type        = string
}

variable "host" {
  description = "Public hostname; the DNS zone's apex and the Ingress host."
  type        = string
  default     = "staging.oharness.dev"
}

variable "dns_zone_name" {
  description = "Cloud DNS managed zone resource name to create for this environment."
  type        = string
  default     = "staging-oharness-dev"
}

variable "app_service_account_id" {
  description = "Account ID of the app GCP service account. Its email is <id>@<project>.iam.gserviceaccount.com."
  type        = string
  default     = "openharness-app"
}

variable "production_node_service_account_email" {
  description = "Production's GKE node service account, granted resource-level read on this project's Artifact Registry repository. Its email is predictable: gke-nodes@openharness-510710.iam.gserviceaccount.com."
  type        = string
  default     = "gke-nodes@openharness-510710.iam.gserviceaccount.com"
}

variable "google_client_id" {
  description = "Google OAuth client ID. Empty disables Google sign-in and its client secret."
  type        = string
  default     = ""
}

variable "github_client_id" {
  description = "GitHub OAuth client ID. Empty disables GitHub sign-in and its client secret."
  type        = string
  default     = ""
}

variable "microsoft_client_id" {
  description = "Microsoft OAuth client ID. Empty disables Microsoft sign-in and its client secret."
  type        = string
  default     = ""
}

variable "microsoft_tenant_id" {
  description = "Microsoft tenant ID, passed to the app only when non-empty."
  type        = string
  default     = ""
}

variable "db_tier" {
  description = "Cloud SQL machine tier. A shared-core tier in staging."
  type        = string
  default     = "db-g1-small"
}

variable "db_availability_type" {
  description = "Cloud SQL availability. Staging runs a single zone."
  type        = string
  default     = "ZONAL"
}

variable "db_backup_enabled" {
  description = "Automated Cloud SQL backups. Off in staging."
  type        = bool
  default     = false
}

variable "db_point_in_time_recovery_enabled" {
  description = "Cloud SQL point-in-time recovery. Off in staging."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Block Terraform from destroying the cluster, the database and the secrets. Off in staging so the environment can be torn down."
  type        = bool
  default     = false
}

variable "enable_budget" {
  description = "Create the billing budget. Off by default: deploy@ needs roles/billing.costsManager on the billing account first (infra/README.md)."
  type        = bool
  default     = false
}

variable "billing_account_id" {
  description = "Billing account ID for the budget, only used when enable_budget is true."
  type        = string
  default     = ""
}

variable "budget_amount" {
  description = "Monthly budget amount in USD, with alerts at 50%, 90% and 100%."
  type        = number
  default     = 100
}

variable "trace_sample_rate" {
  description = "OPENHARNESS_TRACE_SAMPLE_RATE (#158): the fraction of traces exported to Cloud Trace; 0..1."
  type        = number
  default     = 0.1
}

variable "alert_email" {
  description = "Address the monitoring alerts are emailed to (#158). Empty (the default) creates no notification channel and no alert policies, so an apply without it succeeds."
  type        = string
  default     = ""
}
