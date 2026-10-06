output "instance_name" {
  description = "Name of the Cloud SQL instance."
  value       = google_sql_database_instance.main.name
}

output "instance_connection_name" {
  description = "Connection name (project:region:instance). The Cloud SQL Auth Proxy sidecar's target (#159); the app module passes it to the chart."
  value       = google_sql_database_instance.main.connection_name
}

output "private_ip" {
  description = "Private IP the Cloud SQL Auth Proxy sidecar reaches the instance on. Always private: the instance has no public address. Not what the app connects to — its `database_url` names 127.0.0.1."
  value       = tolist([for ip in google_sql_database_instance.main.ip_address : ip.ip_address if ip.type == "PRIVATE"])[0]
}

output "db_name" {
  description = "Database name."
  value       = google_sql_database.db.name
}

output "db_user" {
  description = "Application database user."
  value       = google_sql_user.user.name
}

output "db_password" {
  description = "Generated password for the application user. Feeds the database-url secret version."
  value       = random_password.db.result
  sensitive   = true
}
