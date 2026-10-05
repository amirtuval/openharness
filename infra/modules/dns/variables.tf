variable "project_id" {
  description = "GCP project ID the zone lives in (never the display name)."
  type        = string
}

variable "zone_name" {
  description = "Resource name of the managed zone: the name to create, or the name of the existing zone production adopts."
  type        = string
}

variable "dns_name" {
  description = "The zone's DNS name with a trailing dot, e.g. staging.oharness.dev."
  type        = string
}

variable "description" {
  description = "Zone description. On production's adopted zone this overwrites the existing description."
  type        = string
  default     = "openharness"
}

variable "a_records" {
  description = "A records to write, keyed by fully qualified name with a trailing dot, e.g. { \"app.oharness.dev.\" = \"1.2.3.4\" }."
  type        = map(string)
  default     = {}
}

variable "ns_records" {
  description = "NS delegation records, keyed by the delegated name with a trailing dot, valued with the child zone's name servers. Empty skips the delegation."
  type        = map(list(string))
  default     = {}
}

variable "ttl" {
  description = "TTL in seconds for the records this module writes."
  type        = number
  default     = 300
}
