# Secret Manager secrets (issue #153, epic #148 D5).
#
# Terraform generates the two values it can — the better-auth secret and the DB
# password that goes into database-url — and creates the three provider client
# secrets empty for the maintainer to fill in with
# `gcloud secrets versions add`. KMS, not a secrets key, protects the vault.
#
# All three provider containers are created up front, whatever the client ID
# variables say (#159). The app module mounts a provider's secret only once its
# client ID is set, so a provider that is turned on later finds its container
# already there to be filled in — which is what breaks the chicken-and-egg of
# the old behaviour, where the deploy that turned a provider on was also the
# one that created the secret it needed a version of.

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
# Generated: database-url, built against the Cloud SQL Auth Proxy sidecar
# ---------------------------------------------------------------------------
# The URL names 127.0.0.1: the app connects to the proxy in its own pod, and the
# proxy makes the TLS connection to the instance (#159). See locals.tf.
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
# Empty for manual: one per sign-in provider, always
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret" "provider" {
  for_each = local.provider_secret_ids

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
# project-level: it holds no secretmanager role on the project at large). This
# covers all three provider secrets, including one whose client ID is not set
# yet: the binding is what lets the release mount it the moment that provider is
# turned on, and reading a secret that is not mounted grants nothing.
# ---------------------------------------------------------------------------
resource "google_secret_manager_secret_iam_member" "app" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.app_service_account_email}"
}
