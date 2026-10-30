output "project_id" {
  description = "Project these resources live in."
  value       = var.project_id
}

output "image_tag" {
  description = "The image tag actually deployed. PR plans read this so a plan without -var image_tag reuses what is running."
  value       = var.image_tag
}

output "static_ip" {
  description = "Reserved global IPv4 address behind the Ingress."
  value       = module.app.static_ip_address
}

output "url" {
  description = "Public URL of the environment."
  value       = module.app.url
}

output "name_servers" {
  description = "Name servers of the app.oharness.dev zone: the NS record in the parent zone, oharness.dev (openharness-510710), that delegates the host here."
  value       = module.dns.name_servers
}

output "database_private_ip" {
  description = "Private IP of the Cloud SQL instance, useful when debugging connectivity from inside the VPC."
  value       = module.cloudsql.private_ip
}
