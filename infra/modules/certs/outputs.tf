output "certificate_map_name" {
  description = "Name of the certificate map. It is the chart's gateway.certificateMapName — the Gateway's `networking.gke.io/certmap` annotation."
  value       = google_certificate_manager_certificate_map.host.name
}

output "certificate_name" {
  description = "Name of the Google-managed certificate, for `gcloud certificate-manager certificates describe` when a first deploy's TLS is not up yet."
  value       = google_certificate_manager_certificate.host.name
}

output "dns_authorization_name" {
  description = "Name of the DNS authorization, for `gcloud certificate-manager dns-authorizations describe`."
  value       = google_certificate_manager_dns_authorization.host.name
}

output "dns_authorization_cname_name" {
  description = "Name of the CNAME record that proves control of the host, from the DNS authorization. The environment root feeds it to the dns module's cname_records."
  value       = google_certificate_manager_dns_authorization.host.dns_resource_record[0].name
}

output "dns_authorization_cname_data" {
  description = "Target the CNAME record points at. Certificate Manager issues the certificate once this record resolves; until then the certificate stays PROVISIONING and the load balancer serves the default certificate."
  value       = google_certificate_manager_dns_authorization.host.dns_resource_record[0].data
}
