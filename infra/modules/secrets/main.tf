# Secret Manager secrets (issue #153, epic #148 D5).
#
# Terraform generates the two values it can — the better-auth secret and the DB
# password that goes into database-url — and creates the three provider client
# secrets empty for the maintainer to fill in with
# `gcloud secrets versions add`. KMS, not a secrets key, protects the vault.

# ---------------------------------------------------------------------------
# Generated: better-auth-secret
# ---------------------------------------------------------------------------
resource "random_password" "better_auth" {
  length      = 48
  special     = false
  min_upper   = 6
  min_lower   = 6
  min_numeric = 6
}

resource "google_secret_manager_secret" "better_auth" {
  project   = var.project_id
  secret_id = "better-auth-secret"

  replication {
    auto {}
  }

  deletion_protection = var.deletion_protection

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

resource "google_secret_manager_secret_version" "better_auth" {
  secret      = google_secret_manager_secret.better_auth.id
  secret_data = random_password.better_auth.result
}

# ---------------------------------------------------------------------------
# Generated: database-url, built from the Cloud SQL instance's private IP
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = "database-url"

  replication {
    auto {}
  }

  deletion_protection = var.deletion_protection

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

# ---------------------------------------------------------------------------
# Empty for manual: one per sign-in provider whose client ID is configured
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret" "provider" {
  for_each = local.enabled_providers

  project   = var.project_id
  secret_id = local.provider_secret_ids[each.key]

  replication {
    auto {}
  }

  deletion_protection = var.deletion_protection

  labels = {
    environment = var.environment
    managed-by  = "terraform"
  }
}

# ---------------------------------------------------------------------------
# The app service account may read each secret it is given (resource-level, not
# project-level: it holds no secretmanager role on the project at large)
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret_iam_member" "app" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.app_service_account_email}"
}
