variable "project_id" {
  description = "GCP project ID the certificates live in (never the display name)."
  type        = string
}

variable "host" {
  description = "The hostname to certify, e.g. staging.oharness.dev. It is the DNS authorization's domain, the certificate's domain, and the certificate map entry's hostname — the Gateway answers for exactly this name."
  type        = string
}

variable "name" {
  description = "Base name for the four resources this module creates: <name>-dns-auth, <name>-cert, <name>-certmap, <name>-certmap-entry. Defaults to the release name, which is what the Gateway's certmap annotation and the chart's gateway.certificateMapName value both expect."
  type        = string
  default     = "openharness"

  validation {
    # Certificate Manager names start with a letter and take [a-zA-Z0-9_-]; the suffixes below
    # push the longest of them (16 characters) past 64 only if the base is absurdly long, so the
    # check is a plain shape check plus a length budget.
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_-]*$", var.name)) && length(var.name) <= 48
    error_message = "name must start with a letter, contain only letters, digits, underscores and hyphens, and be at most 48 characters (the resource suffixes add up to 16 more)."
  }
}

variable "location" {
  description = "Certificate Manager location. global: the GKE Gateway is a global external Gateway, and a global managed certificate is what its certificate map takes."
  type        = string
  default     = "global"
}

variable "deletion_protection" {
  description = "Block Terraform from destroying the certificate resources. Mirrors the environment's deletion_protection, which guards the cluster, the database and the secrets: it becomes deletion_policy = PREVENT on the DNS authorization, the certificate and the map. The map entry is left at its default — the provider documents deletion_policy on the other three."
  type        = bool
  default     = true
}
