# Every value below is a *default* for the production environment. Override any
# of them with -var / a tfvars file; image_tag and existing_zone_name have no
# defaults and must be passed.

variable "project_id" {
  description = "Production GCP project ID (never the display name)."
  type        = string
  default     = "openharness-510710"
}

variable "region" {
  description = "GCP region."
  type        = string
  default     = "us-central1"
}

variable "image_repository" {
  description = "Artifact Registry path for the app image, without the tag. The registry lives in the staging project; production pulls from it and never rebuilds."
  type        = string
  default     = "us-central1-docker.pkg.dev/openharness-dev/openharness/server"
}

variable "image_tag" {
  description = "Image tag to deploy — the git SHA the deploy workflow passes with -var image_tag=<sha>. No default: an unpinned apply must fail."
  type        = string
}

variable "host" {
  description = "Public hostname; the Ingress host and BETTER_AUTH_URL."
  type        = string
  default     = "app.oharness.dev"
}

variable "dns_name" {
  description = "The production zone's DNS name, with a trailing dot. Records are written under it; the staging delegation is a child of it."
  type        = string
  default     = "oharness.dev."
}

variable "existing_zone_name" {
  description = "Resource name of the existing oharness.dev managed zone, adopted with an import block. Find it with: gcloud dns managed-zones list --project openharness-510710. Required — there is no default, because the zone is created by hand and its name cannot be guessed."
  type        = string
}

variable "staging_name_servers" {
  description = "Staging's zone name servers, from `terraform output name_servers` in envs/staging. Written as the NS records delegating staging.oharness.dev; empty skips the delegation."
  type        = list(string)
  default     = []
}

variable "app_service_account_id" {
  description = "Account ID of the app GCP service account. Its email is <id>@<project>.iam.gserviceaccount.com."
  type        = string
  default     = "openharness-app"
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
  description = "Cloud SQL machine tier. A small dedicated tier in production."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_availability_type" {
  description = "Cloud SQL availability. ZONAL: production runs a single zone. REGIONAL (HA) was deferred deliberately (#153) because it roughly doubles the Cloud SQL cost; set it back with -var db_availability_type=REGIONAL when HA is wanted."
  type        = string
  default     = "ZONAL"
}

variable "db_backup_enabled" {
  description = "Automated Cloud SQL backups. On in production."
  type        = bool
  default     = true
}

variable "db_point_in_time_recovery_enabled" {
  description = "Cloud SQL point-in-time recovery. On in production."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Block Terraform from destroying the cluster, the database and the secrets. On in production."
  type        = bool
  default     = true
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
