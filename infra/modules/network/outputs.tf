output "network_id" {
  description = "Self link of the VPC."
  value       = google_compute_network.vpc.id
}

output "network_name" {
  description = "Name of the VPC."
  value       = google_compute_network.vpc.name
}

output "subnetwork_id" {
  description = "Self link of the subnet."
  value       = google_compute_subnetwork.subnet.id
}

output "subnetwork_name" {
  description = "Name of the subnet."
  value       = google_compute_subnetwork.subnet.name
}

output "pods_range_name" {
  description = "Name of the pods secondary range."
  value       = var.pods_range_name
}

output "services_range_name" {
  description = "Name of the services secondary range."
  value       = var.services_range_name
}

output "private_services_connection" {
  description = "Private services access connection, which Cloud SQL depends on."
  value       = google_service_networking_connection.private_services.id
}
