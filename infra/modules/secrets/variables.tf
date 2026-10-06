variable "project_id" {
  description = "GCP project ID the secrets live in (never the display name)."
  type        = string
}

variable "environment" {
  description = "Environment label, staging or production, put on every secret."
  type        = string
}

variable "app_service_account_email" {
  description = "Email of the app service account granted secretmanager.secretAccessor on each secret."
  type        = string
}

variable "db_host" {
  description = "Cloud SQL private IP, from the cloudsql module."
  type        = string
}

variable "db_port" {
  description = "Cloud SQL port."
  type        = number
  default     = 5432
}

variable "db_name" {
  description = "Database name, from the cloudsql module."
  type        = string
}

variable "db_user" {
  description = "Application database user, from the cloudsql module."
  type        = string
}

variable "db_password" {
  description = "Generated database password, from the cloudsql module. Embedded in the database-url secret version."
  type        = string
  sensitive   = true
}

variable "deletion_protection" {
  description = "Block Terraform from deleting the secrets. false in staging, true in production."
  type        = bool
  default     = true
}
