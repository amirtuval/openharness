locals {
  environment = "production"

  # Every API this environment needs. `disable_on_destroy = false`: destroying
  # the environment must not tear down APIs the project's other resources (and
  # the setup script's own) still rely on.
  services = [
    "billingbudgets.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudtrace.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "dns.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
  ]

  # The delegation record lives in production's oharness.dev zone, at the child
  # name staging's zone is authoritative for.
  staging_delegation_name = "staging.${var.dns_name}"

  # Empty staging_name_servers skips the delegation, so production can be
  # applied before staging exists.
  ns_records = length(var.staging_name_servers) > 0 ? {
    (local.staging_delegation_name) = var.staging_name_servers
  } : {}
}

data "google_client_config" "default" {}

data "google_project" "current" {
  project_id = var.project_id
}

# oharness.dev already exists, created by hand. Terraform adopts it rather than
# creating a second zone. The import block must live in a root module, which is
# why it is here and not in modules/dns. It is idempotent: once the zone is in
# state the import is a no-op, and it can stay in the configuration.
#
# Find the name to put in existing_zone_name with:
#   gcloud dns managed-zones list --project openharness-510710
import {
  to = module.dns.google_dns_managed_zone.zone
  id = "projects/${var.project_id}/managedZones/${var.existing_zone_name}"
}

resource "google_project_service" "services" {
  for_each = toset(local.services)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# The app's GCP identity. It is created here rather than inside the `app`
# module: `kms` and `secrets` bind their IAM to it, and the `app` module needs
# their outputs, so creating it in the app module would be a module cycle.
# The `app` module still owns the Workload Identity binding to the Kubernetes
# service account, the project roles and the helm_release.
resource "google_service_account" "app" {
  project      = var.project_id
  account_id   = var.app_service_account_id
  display_name = "openharness app (${local.environment})"
  description  = "Runtime identity for the openharness app, linked through Workload Identity to the openharness/openharness Kubernetes service account."
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Pinned and configured for the resources that land in google-beta; nothing in
# this environment needs it today.
provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# Both Kubernetes-facing providers authenticate to the cluster with the deploy
# service account's short-lived access token.
provider "helm" {
  kubernetes = {
    host                   = "https://${module.gke.endpoint}"
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = base64decode(module.gke.ca_certificate)
  }
}

provider "kubernetes" {
  host                   = "https://${module.gke.endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(module.gke.ca_certificate)
}

module "network" {
  source = "../../modules/network"

  project_id = var.project_id
  region     = var.region

  depends_on = [google_project_service.services]
}

module "gke" {
  source = "../../modules/gke"

  project_id = var.project_id
  region     = var.region

  network_id          = module.network.network_id
  subnetwork_id       = module.network.subnetwork_id
  pods_range_name     = module.network.pods_range_name
  services_range_name = module.network.services_range_name

  deletion_protection = var.deletion_protection

  depends_on = [google_project_service.services]
}

module "cloudsql" {
  source = "../../modules/cloudsql"

  project_id                  = var.project_id
  region                      = var.region
  network_id                  = module.network.network_id
  private_services_connection = module.network.private_services_connection

  tier                           = var.db_tier
  availability_type              = var.db_availability_type
  backup_enabled                 = var.db_backup_enabled
  point_in_time_recovery_enabled = var.db_point_in_time_recovery_enabled
  deletion_protection            = var.deletion_protection

  depends_on = [google_project_service.services]
}

module "kms" {
  source = "../../modules/kms"

  project_id                = var.project_id
  region                    = var.region
  app_service_account_email = google_service_account.app.email

  depends_on = [google_project_service.services]
}

module "secrets" {
  source = "../../modules/secrets"

  project_id                = var.project_id
  environment               = local.environment
  app_service_account_email = google_service_account.app.email

  db_name     = module.cloudsql.db_name
  db_user     = module.cloudsql.db_user
  db_password = module.cloudsql.db_password

  deletion_protection = var.deletion_protection

  depends_on = [google_project_service.services]
}

# TLS for the Gateway (#159), same shape as staging's. `app.oharness.dev`'s CNAME
# goes into the oharness.dev zone this environment adopts, one record among the
# zone's others (the `import` block above is what puts the zone itself in state).
module "certs" {
  source = "../../modules/certs"

  project_id = var.project_id
  host       = var.host

  # Production is guarded: the certificate resources cannot be destroyed by an
  # apply, the same way the cluster, the database and the secrets cannot.
  deletion_protection = var.deletion_protection

  depends_on = [google_project_service.services]
}

module "app" {
  source = "../../modules/app"

  project_id                = var.project_id
  app_service_account_email = google_service_account.app.email

  # Production pulls the image staging built; it never rebuilds one.
  image_repository = var.image_repository
  image_tag        = var.image_tag
  host             = var.host

  # The Gateway's TLS (#159): the certificate map the Gateway names in its
  # `networking.gke.io/certmap` annotation.
  certificate_map_name = module.certs.certificate_map_name

  kms_key_id             = module.kms.crypto_key_id
  database_url_secret_id = module.secrets.database_url_secret_id
  better_auth_secret_id  = module.secrets.better_auth_secret_id
  provider_secret_ids    = module.secrets.provider_secret_ids

  # #159: the Cloud SQL Auth Proxy sidecar's target. The app does not reach the
  # instance's private IP itself — its `database_url` names 127.0.0.1, and this
  # is what the proxy in front of it connects to.
  cloudsql_instance_connection_name = module.cloudsql.instance_connection_name

  google_client_id    = var.google_client_id
  github_client_id    = var.github_client_id
  microsoft_client_id = var.microsoft_client_id
  microsoft_tenant_id = var.microsoft_tenant_id

  # #158: how much of the traffic is traced. The app module turns Cloud Trace on
  # and passes this as OPENHARNESS_TRACE_SAMPLE_RATE.
  trace_sample_rate = var.trace_sample_rate

  # The cluster, the database and the secrets must all exist before the release
  # rolls out: the pods read the secrets and the database at start-up.
  depends_on = [
    module.cloudsql,
    module.gke,
    module.kms,
    module.network,
    module.secrets,
  ]
}

# Monitoring (#158): the uptime check on https://<host>/health, and — once
# `alert_email` is set — the email channel and the alert policies over it,
# Cloud SQL and the deployment's containers. Empty `alert_email` (the default)
# creates neither a channel nor a policy, so the first apply needs no address.
module "monitoring" {
  source = "../../modules/monitoring"

  project_id  = var.project_id
  host        = var.host
  alert_email = var.alert_email
  name_prefix = "openharness ${local.environment}"

  depends_on = [google_project_service.services]
}

module "dns" {
  source = "../../modules/dns"

  project_id = var.project_id
  dns_name   = var.dns_name

  # Production adopts the zone that already exists, oharness.dev, instead of
  # creating a second one — see the import block above.
  zone_name   = var.existing_zone_name
  description = "openharness production"

  a_records = {
    "${var.host}." = module.app.static_ip_address
  }

  # Certificate Manager's proof that this project controls the host (#159),
  # published in the adopted oharness.dev zone — `_acme-challenge.<host>.` →
  # Certificate Manager. The certificate stays PROVISIONING until it resolves.
  # Static key, apply-time value: the `dns` module's `cname_records` explains why.
  cname_records = {
    certificate-authorization = {
      name   = module.certs.dns_authorization_cname_name
      target = module.certs.dns_authorization_cname_data
    }
  }

  # Delegate staging.oharness.dev to the zone staging created. Empty skips it.
  ns_records = local.ns_records

  depends_on = [google_project_service.services]
}

module "budget" {
  count = var.enable_budget ? 1 : 0

  source = "../../modules/budget"

  billing_account_id = var.billing_account_id
  project_number     = data.google_project.current.number
  display_name       = "openharness ${local.environment} monthly"
  amount             = var.budget_amount
}
