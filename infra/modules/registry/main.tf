# Artifact Registry (issue #153, epic #148 D2). Instantiated in staging only:
# the one registry lives in the staging project, production pulls from it and
# never rebuilds (us-central1-docker.pkg.dev/openharness-dev/openharness/server).

resource "google_artifact_registry_repository" "repo" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = var.description
  labels = {
    managed-by = "terraform"
  }
}

# Resource-level, by email: each environment's GKE node service account may pull
# from this repository, and holds no registry role on the project at large.
resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each = toset(var.reader_service_accounts)

  project    = var.project_id
  location   = google_artifact_registry_repository.repo.location
  repository = google_artifact_registry_repository.repo.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${each.value}"
}
