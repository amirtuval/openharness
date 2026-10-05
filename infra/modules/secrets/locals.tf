locals {
  # The three sign-in providers whose client secret the maintainer supplies by
  # hand, keyed by the provider name the app module uses.
  provider_client_ids = {
    google    = var.google_client_id
    github    = var.github_client_id
    microsoft = var.microsoft_client_id
  }

  provider_secret_ids = {
    google    = "google-client-secret"
    github    = "github-client-secret"
    microsoft = "microsoft-client-secret"
  }

  # A secret is created only for a provider that is actually configured: a
  # secret with no version would block the pod from starting.
  enabled_providers = toset([for name, client_id in local.provider_client_ids : name if client_id != ""])

  # Every secret this module owns, by secret_id. The IAM binding below and the
  # app module's `secrets` list both key off these.
  secrets = merge(
    {
      (google_secret_manager_secret.better_auth.secret_id)  = google_secret_manager_secret.better_auth
      (google_secret_manager_secret.database_url.secret_id) = google_secret_manager_secret.database_url
    },
    { for name, secret in google_secret_manager_secret.provider : secret.secret_id => secret },
  )

  # sslmode=require matches the instance's ENCRYPTED_ONLY SSL mode; the user and
  # password are percent-encoded so a generated password can never break the URL.
  database_url = format(
    "postgres://%s:%s@%s:%d/%s?sslmode=require",
    urlencode(var.db_user),
    urlencode(var.db_password),
    var.db_host,
    var.db_port,
    var.db_name,
  )
}
