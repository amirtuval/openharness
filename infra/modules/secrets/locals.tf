locals {
  # The three sign-in providers whose client secret the maintainer supplies by
  # hand, keyed by the provider name the app module uses. All three containers
  # are created unconditionally (#159) — the app module decides which of them to
  # mount from the client ID variables, so creating one early costs nothing and
  # gives the maintainer somewhere to put the version before the provider is on.
  provider_secret_ids = {
    google    = "google-client-secret"
    github    = "github-client-secret"
    microsoft = "microsoft-client-secret"
  }

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
