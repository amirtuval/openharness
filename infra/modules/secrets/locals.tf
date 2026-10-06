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

  # The app does not talk to the Cloud SQL instance directly: it talks to the
  # Cloud SQL Auth Proxy running as a sidecar in its own pod (#159), so the host
  # is the pod's loopback and the port is the proxy's listener. The proxy is what
  # speaks TLS to the instance over the private IP, using the pod's Workload
  # Identity — so `sslmode=disable` is correct here and is *not* a downgrade:
  # the only hop it describes is the pod-local one, over a loopback interface
  # nothing else can reach. Turning verification off against the *instance*
  # (the old `sslmode=require` against its private IP, which node-postgres reads
  # as verify-full) is what failed with UNABLE_TO_VERIFY_LEAF_SIGNATURE:
  # Cloud SQL's server certificate is signed by a per-instance Google CA that is
  # not in Node's trust store.
  #
  # The user and password are percent-encoded so a generated password can never
  # break the URL.
  database_url = format(
    "postgres://%s:%s@127.0.0.1:%d/%s?sslmode=disable",
    urlencode(var.db_user),
    urlencode(var.db_password),
    var.db_port,
    var.db_name,
  )
}
