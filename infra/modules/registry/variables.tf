variable "project_id" {
  description = "GCP project ID the registry lives in — the staging project, openharness-dev."
  type        = string
}

variable "region" {
  description = "Registry location, us-central1 for every openharness environment."
  type        = string
  default     = "us-central1"
}

variable "repository_id" {
  description = "Repository ID. The image path is <region>-docker.pkg.dev/<project>/<repository_id>/server."
  type        = string
  default     = "openharness"
}

variable "description" {
  description = "Repository description."
  type        = string
  default     = "openharness server and web image"
}

variable "reader_service_accounts" {
  description = "Service account emails granted resource-level artifactregistry.reader on the repository — the GKE node accounts whose nodes pull the image. roles/container.defaultNodeServiceAccount does not carry artifactregistry.reader, so every cluster that runs the image needs this."
  type        = list(string)
  default     = []
}
