output "static_ip_name" {
  description = "Name of the reserved global address, as the Ingress claims it."
  value       = google_compute_global_address.static_ip.name
}

output "static_ip_address" {
  description = "The reserved global IPv4 address. Staging's and production's A records point at it."
  value       = google_compute_global_address.static_ip.address
}

output "url" {
  description = "Public URL of the environment."
  value       = "https://${var.host}"
}

output "release_name" {
  description = "Helm release name."
  value       = helm_release.app.name
}

output "namespace" {
  description = "Namespace the release was installed into."
  value       = helm_release.app.namespace
}

output "env" {
  description = "The plain, non-secret environment Terraform passes to the chart."
  value       = local.env
}

output "secret_envs" {
  description = "The environment variables delivered as secrets, for the README's manual-secret table."
  value       = [for entry in local.secrets : entry.env]
}
