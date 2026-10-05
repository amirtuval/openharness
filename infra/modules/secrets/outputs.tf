output "better_auth_secret_id" {
  description = "Secret ID of the generated better-auth secret."
  value       = google_secret_manager_secret.better_auth.secret_id
}

output "database_url_secret_id" {
  description = "Secret ID of the generated database-url secret."
  value       = google_secret_manager_secret.database_url.secret_id
}

output "provider_secret_ids" {
  description = "Secret IDs of the empty, manually filled provider client secrets, keyed by provider (google, github, microsoft)."
  value       = { for name, secret in google_secret_manager_secret.provider : name => secret.secret_id }
}

output "secret_ids" {
  description = "Every secret ID this module owns, for the app module's chart values and for the README's manual-secret table."
  value       = sort(keys(local.secrets))
}
