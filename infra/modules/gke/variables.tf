variable "project_id" {
  description = "GCP project ID the cluster lives in (never the display name)."
  type        = string
}

variable "region" {
  description = "GCP region, us-central1 for every openharness environment."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Cluster name, also used in the node service account's display name."
  type        = string
  default     = "openharness"
}

variable "network_id" {
  description = "Self link of the VPC to create the cluster in."
  type        = string
}

variable "subnetwork_id" {
  description = "Self link of the subnet to create the cluster in."
  type        = string
}

variable "pods_range_name" {
  description = "Name of the subnet's secondary range for pods."
  type        = string
}

variable "services_range_name" {
  description = "Name of the subnet's secondary range for services."
  type        = string
}

variable "node_service_account_id" {
  description = "Account ID of the custom node service account. Its email is <id>@<project>.iam.gserviceaccount.com — staging names production's account with exactly this value."
  type        = string
  default     = "gke-nodes"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.node_service_account_id))
    error_message = "GCP service account IDs must be 6-30 characters, start with a letter and end with a letter or digit."
  }
}

variable "release_channel" {
  description = "GKE release channel. Autopilot clusters must be on one."
  type        = string
  default     = "REGULAR"

  validation {
    condition     = contains(["RAPID", "REGULAR", "STABLE"], var.release_channel)
    error_message = "release_channel must be RAPID, REGULAR or STABLE."
  }
}

variable "gateway_api_channel" {
  description = "Gateway API channel. CHANNEL_STANDARD installs the standard Gateway API CRDs and runs the controller the chart's Gateway and HTTPRoutes need (#159); CHANNEL_EXPERIMENTAL is deprecated in favour of it, and CHANNEL_DISABLED turns the API off — which would leave the chart's Gateway unreconciled. Changing it is an in-place cluster update."
  type        = string
  default     = "CHANNEL_STANDARD"

  validation {
    condition     = contains(["CHANNEL_STANDARD", "CHANNEL_EXPERIMENTAL", "CHANNEL_DISABLED"], var.gateway_api_channel)
    error_message = "gateway_api_channel must be CHANNEL_STANDARD, CHANNEL_EXPERIMENTAL or CHANNEL_DISABLED."
  }
}

variable "master_ipv4_cidr_block" {
  description = "A /28 CIDR for the control plane's private peering, not overlapping the VPC's subnet, pods or services ranges."
  type        = string
  default     = "172.16.0.0/28"
}

variable "deletion_protection" {
  description = "Block Terraform from destroying the cluster. false in staging, true in production."
  type        = bool
  default     = true
}
