variable "project_id" {
  description = "GCP project ID this network lives in (never the display name)."
  type        = string
}

variable "region" {
  description = "GCP region, us-central1 for every openharness environment."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Base name for the VPC, subnet, router and NAT."
  type        = string
  default     = "openharness"
}

variable "subnet_cidr" {
  description = "Primary (node) CIDR for the subnet."
  type        = string
  default     = "10.0.0.0/20"
}

variable "pods_cidr" {
  description = "Secondary CIDR for GKE pods. Must not overlap the subnet, the services range or the Cloud SQL peering range."
  type        = string
  default     = "10.16.0.0/14"
}

variable "services_cidr" {
  description = "Secondary CIDR for GKE services. Must not overlap the subnet or the pods range."
  type        = string
  default     = "10.20.0.0/20"
}

variable "pods_range_name" {
  description = "Name of the subnet's pods secondary range, referenced by the GKE cluster."
  type        = string
  default     = "pods"
}

variable "services_range_name" {
  description = "Name of the subnet's services secondary range, referenced by the GKE cluster."
  type        = string
  default     = "services"
}

variable "private_services_prefix_length" {
  description = "Prefix length of the private services access range Cloud SQL's private IP comes from. /16 is the Cloud SQL minimum for a single instance."
  type        = number
  default     = 16

  validation {
    condition     = var.private_services_prefix_length >= 16 && var.private_services_prefix_length <= 24
    error_message = "Cloud SQL private services access requires a prefix length between /16 and /24."
  }
}
