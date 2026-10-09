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

variable "cname_records" {
  description = "CNAME records to write, keyed by a caller-chosen label, each holding the fully qualified name (with a trailing dot) and its target. The Certificate Manager DNS authorization's validation record is the one this module is given today; empty writes none."
  type = map(object({
    name   = string
    target = string
  }))
  default = {}

  # The key is a label and not the record's own name on purpose (#159). The
  # authorization's record name comes back from a resource attribute, so it is not
  # known until apply — and `for_each` cannot accept keys it cannot see at plan
  # time. `a_records` can be keyed by name because its names come from variables;
  # this map cannot. A PR plan caught that ("var.cname_records is a map of string,
  # known only after apply"), which is what this shape exists to avoid.
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
