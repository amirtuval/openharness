# Every value below is a *default* for the environment — the only one: this root
# is named `staging` for history, and serves app.oharness.dev. Override any of
# them with -var / a tfvars file; image_tag has no default and must be passed
# (the deploy workflow passes the git SHA).

variable "project_id" {
  description = "GCP project ID (never the display name)."
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
  default     = "app.oharness.dev"
}

variable "dns_zone_name" {
  description = "Cloud DNS managed zone resource name to create for this environment."
  type        = string
  default     = "app-oharness-dev"
}

variable "app_service_account_id" {
  description = "Account ID of the app GCP service account. Its email is <id>@<project>.iam.gserviceaccount.com."
  type        = string
  default     = "openharness-app"
}

variable "google_client_id" {
  description = "Google OAuth client ID. Empty disables Google sign-in; the google-client-secret container is created either way (#159), and the app mounts it only while this is set."
  type        = string
  default     = ""
}

variable "github_client_id" {
  description = "GitHub OAuth client ID. Empty disables GitHub sign-in; the github-client-secret container is created either way (#159), and the app mounts it only while this is set."
  type        = string
  default     = ""
}

variable "microsoft_client_id" {
  description = "Microsoft OAuth client ID. Empty disables Microsoft sign-in; the microsoft-client-secret container is created either way (#159), and the app mounts it only while this is set."
  type        = string
  default     = ""
}

variable "microsoft_tenant_id" {
  description = "Microsoft tenant ID, passed to the app only when non-empty."
  type        = string
  default     = ""
}

variable "db_tier" {
  description = "Cloud SQL machine tier. The smallest shared-core tier: a demo's load fits, and it costs about a third of db-g1-small."
  type        = string
  default     = "db-f1-micro"
}

variable "db_availability_type" {
  description = "Cloud SQL availability. A single zone; REGIONAL (HA) roughly doubles the database's cost."
  type        = string
  default     = "ZONAL"
}

variable "db_backup_enabled" {
  description = "Automated daily Cloud SQL backups. On: this is the only environment, so its database is the only copy of the data."
  type        = bool
  default     = true
}

variable "db_point_in_time_recovery_enabled" {
  description = "Cloud SQL point-in-time recovery. Off: daily backups are enough for a demo, and the write-ahead logs it keeps are billed as storage."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Block Terraform from destroying the cluster, the database, the secrets and the certificate. Off, so the host can move and the environment can be torn down; the database's daily backups are the safety net."
  type        = bool
  default     = false
}

variable "enable_budget" {
  description = "Create the billing budget. Off by default: deploy@ needs roles/billing.costsManager on the billing account first (infra/README.md)."
  type        = bool
  default     = false
}

variable "billing_account_id" {
  description = "Billing account ID for the budget, only used when enable_budget is true. The bare ID (XXXXXX-XXXXXX-XXXXXX, the ACCOUNT_ID column of `gcloud billing accounts list`); a leading `billingAccounts/` is accepted and stripped (#159)."
  type        = string
  default     = ""
}

variable "budget_amount" {
  description = "Monthly budget amount, in the billing account's currency, with alerts at 50%, 90% and 100%. The deploy workflows and the PR plan pass it when the repository variable TF_BUDGET_AMOUNT_STAGING is set, and leave this default otherwise; a budget whose currency does not match the account's is rejected with a 400 (#159)."
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
