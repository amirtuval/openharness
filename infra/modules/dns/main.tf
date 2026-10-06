# Cloud DNS: one zone per environment, its A record, the CNAME that proves
# ownership of the host to Certificate Manager, and — in production — the NS
# records that delegate staging (issue #153, epic #148 D7; the CNAME, #159).
#
# Staging creates its own zone (staging.oharness.dev). Production adopts the
# zone that already exists, oharness.dev: the resource name is not knowable
# ahead of time, so it is the required root variable `existing_zone_name`, found
# with `gcloud dns managed-zones list --project openharness-510710`, and the
# adoption itself is an `import` block in the production root — Terraform only
# allows import blocks in a root module, not here.

resource "google_dns_managed_zone" "zone" {
  project     = var.project_id
  name        = var.zone_name
  dns_name    = var.dns_name
  description = var.description
  visibility  = "public"
}

resource "google_dns_record_set" "a" {
  for_each = var.a_records

  project      = var.project_id
  managed_zone = google_dns_managed_zone.zone.name
  name         = each.key
  type         = "A"
  ttl          = var.ttl
  rrdatas      = [each.value]
}

# CNAME records. One is the Certificate Manager DNS authorization's validation
# record (#159): `_acme-challenge.<domain>.` → the target Certificate Manager hands
# back, which is what proves the domain and lets the managed certificate issue. The
# record is written here rather than in the `certs` module because the zone is
# this module's, and a module that writes into another module's resource is a
# dependency the graph does not need.
resource "google_dns_record_set" "cname" {
  for_each = var.cname_records

  project      = var.project_id
  managed_zone = google_dns_managed_zone.zone.name
  # The record's name is `each.value.name`, not the map key: the key is a static
  # label, because this record's name is an apply-time result (see the variable).
  name    = each.value.name
  type    = "CNAME"
  ttl     = var.ttl
  rrdatas = [each.value.target]
}

# Delegation records in the parent zone: an NS set at a child name, holding the
# child zone's name servers. Staging's name servers come from staging's output.
resource "google_dns_record_set" "ns" {
  for_each = var.ns_records

  project      = var.project_id
  managed_zone = google_dns_managed_zone.zone.name
  name         = each.key
  type         = "NS"
  ttl          = var.ttl
  rrdatas      = each.value
}
