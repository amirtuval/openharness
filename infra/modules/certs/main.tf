# TLS for the Gateway (#159): a Google-managed certificate for the host, its DNS
# authorization, and the certificate map the Gateway names in its
# `networking.gke.io/certmap` annotation.
#
# The Ingress stack this replaces used the GKE *ManagedCertificate* CRD and the
# `networking.gke.io/managed-certificates` annotation — a GKE-owned certificate
# per Ingress, issued once a DNS record pointed at the load balancer. The Gateway
# API takes certificates from **Certificate Manager** instead, and the indirection
# is deliberate: the Gateway annotation names a *map*, so one Gateway can serve
# many hosts, and a map entry can be repointed at a new certificate without
# touching the Gateway.
#
# The chain, in the order it has to happen (and the order Terraform's graph
# already produces — each resource references the one before it):
#
#   dns_authorization   proves control of the domain: it hands back a CNAME record
#                       the caller publishes in the domain's Cloud DNS zone
#   certificate         a Google-managed certificate, issued once the CNAME
#                       resolves; `dns_authorizations` is what tells Certificate
#                       Manager which authorization to prove the domain with (it
#                       is the alternative to an issuance config, not an addition)
#   certificate_map     the container the Gateway annotation names
#   certificate_map_entry  binds the hostname to the certificate inside that map;
#                       a map needs at least one entry, and one entry is one host
#
# The CNAME is *not* written here: this module only hands the record out, and the
# `dns` module writes it into the environment's zone (staging's own, production's
# adopted oharness.dev). That split is what keeps the graph acyclic — see the
# comment on `module.certs` in each environment root.

resource "google_certificate_manager_dns_authorization" "host" {
  project     = var.project_id
  name        = "${var.name}-dns-auth"
  location    = var.location
  domain      = var.host
  description = "openharness DNS authorization for ${var.host}"

  # FIXED_RECORD (the default for a global authorization) is the CNAME this module
  # exports; PER_PROJECT_RECORD is the alternative and needs a different record.
  type = "FIXED_RECORD"

  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"
}

resource "google_certificate_manager_certificate" "host" {
  project     = var.project_id
  name        = "${var.name}-cert"
  location    = var.location
  description = "openharness Google-managed certificate for ${var.host}"

  # DEFAULT is the scope for a Google-managed certificate served by a global
  # external load balancer; EDGE_CACHE would be for Cloud CDN's own certs.
  scope = "DEFAULT"

  managed {
    domains = [var.host]
    # Which DNS authorization proves the domain. Required for a managed
    # certificate: the provider takes either this or an `issuance_config`, never
    # both, and the certificate stays PROVISIONING until the CNAME resolves.
    dns_authorizations = [google_certificate_manager_dns_authorization.host.id]
  }

  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"
}

resource "google_certificate_manager_certificate_map" "host" {
  project     = var.project_id
  name        = "${var.name}-certmap"
  description = "openharness certificate map for ${var.host}"

  # Certificate maps are global: the provider takes no location here, unlike the
  # resources above.
  deletion_policy = var.deletion_protection ? "PREVENT" : "DELETE"
}

resource "google_certificate_manager_certificate_map_entry" "host" {
  project = var.project_id
  name    = "${var.name}-certmap-entry"
  map     = google_certificate_manager_certificate_map.host.name

  # One entry is one hostname: the map is what a Gateway annotation names, and the
  # entry is how a request for this host finds this certificate.
  hostname     = var.host
  certificates = [google_certificate_manager_certificate.host.id]
}
