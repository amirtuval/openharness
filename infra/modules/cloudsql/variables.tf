variable "project_id" {
  description = "GCP project ID the instance lives in (never the display name)."
  type        = string
}

variable "region" {
  description = "GCP region, us-central1 for every openharness environment."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Instance name. Cloud SQL cannot reuse a name for about a week after deletion."
  type        = string
  default     = "openharness"
}

variable "database_version" {
  description = "Postgres major version. POSTGRES_18 is the newest the provider supports."
  type        = string
  default     = "POSTGRES_18"
}

variable "network_id" {
  description = "Self link of the VPC the private IP is served from."
  type        = string
}

variable "private_services_connection" {
  description = "Private services access connection to wait for; the instance cannot get a private IP until the peering exists."
  type        = string
}

variable "tier" {
  description = "Machine tier. Staging uses a shared-core tier (db-g1-small), production a small dedicated one (db-custom-1-3840)."
  type        = string
}

variable "availability_type" {
  description = "ZONAL or REGIONAL. Staging is single-zone; production runs a regional (HA) instance."
  type        = string
  default     = "ZONAL"

  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.availability_type)
    error_message = "availability_type must be ZONAL or REGIONAL."
  }
}

variable "disk_size_gb" {
  description = "Initial data disk size in GB; autoresize is on."
  type        = number
  default     = 10
}

variable "backup_enabled" {
  description = "Automated daily backups. On in production, off in staging."
  type        = bool
  default     = false
}

variable "point_in_time_recovery_enabled" {
  description = "Point-in-time recovery (requires backups). On in production, off in staging."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Block Terraform from destroying the instance. false in staging, true in production."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Database name."
  type        = string
  default     = "openharness"
}

variable "db_user" {
  description = "Application database user. Its password is generated and written to the database-url secret."
  type        = string
  default     = "openharness"
}
