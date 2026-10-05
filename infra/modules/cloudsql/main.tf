# Cloud SQL Postgres, private IP only, with the database, the user and the
# generated password (issue #153, epic #148 D4/D5).
#
# Cloud SQL 18 is the newest Postgres major the provider's `database_version`
# accepts (POSTGRES_18), so that is what both environments run.

resource "random_password" "db" {
  length      = 32
  special     = false # the password is embedded in DATABASE_URL; keep it URL-safe
  min_upper   = 4
  min_lower   = 4
  min_numeric = 4
}

resource "google_sql_database_instance" "main" {
  project          = var.project_id
  name             = var.name
  region           = var.region
  database_version = var.database_version

  # The instance is private-only: it needs the private services access peering
  # to exist, which the network module creates.
  depends_on = [var.private_services_connection]

  deletion_protection = var.deletion_protection

  settings {
    tier              = var.tier
    availability_type = var.availability_type
    disk_size         = var.disk_size_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = true
    edition           = "ENTERPRISE"

    ip_configuration {
      # No public IP at all, and TLS required for the connections that do reach
      # it — the app connects with sslmode=require.
      ipv4_enabled    = false
      private_network = var.network_id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = var.backup_enabled
      point_in_time_recovery_enabled = var.point_in_time_recovery_enabled
      start_time                     = "03:00"
    }

    user_labels = {
      environment = var.name
      managed-by  = "terraform"
    }
  }
}

resource "google_sql_database" "db" {
  project  = var.project_id
  name     = var.db_name
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "user" {
  project  = var.project_id
  name     = var.db_user
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
