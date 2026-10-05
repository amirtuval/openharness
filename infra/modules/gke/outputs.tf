output "cluster_name" {
  description = "Name of the cluster."
  value       = google_container_cluster.cluster.name
}

output "cluster_id" {
  description = "Self link of the cluster."
  value       = google_container_cluster.cluster.id
}

output "location" {
  description = "Cluster location, used as the endpoint's region."
  value       = google_container_cluster.cluster.location
}

output "endpoint" {
  description = "Public IP of the control plane endpoint, which the helm and kubernetes providers connect to."
  value       = google_container_cluster.cluster.endpoint
}

output "ca_certificate" {
  description = "Base64-encoded cluster CA certificate, which the helm and kubernetes providers need."
  value       = google_container_cluster.cluster.master_auth[0].cluster_ca_certificate
}

output "workload_pool" {
  description = "Workload Identity pool, <project>.svc.id.goog."
  value       = google_container_cluster.cluster.workload_identity_config[0].workload_pool
}

output "node_service_account_email" {
  description = "Email of the custom node service account — what production's registry read is granted to from staging."
  value       = google_service_account.nodes.email
}
