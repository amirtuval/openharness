output "repository_id" {
  description = "Repository ID."
  value       = google_artifact_registry_repository.repo.repository_id
}

output "repository_url" {
  description = "Docker registry path for the repository, without an image name."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}"
}
