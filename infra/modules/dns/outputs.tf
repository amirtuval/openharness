output "zone_name" {
  description = "Resource name of the managed zone, whether created or adopted."
  value       = google_dns_managed_zone.zone.name
}

output "dns_name" {
  description = "The zone's DNS name."
  value       = google_dns_managed_zone.zone.dns_name
}

output "name_servers" {
  description = "The zone's name servers — what the parent zone's NS record delegates to."
  value       = google_dns_managed_zone.zone.name_servers
}
